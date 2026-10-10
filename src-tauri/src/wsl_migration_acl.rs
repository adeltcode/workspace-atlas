use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{LocalFree, ERROR_INSUFFICIENT_BUFFER};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, GetVolumeInformationByHandleW, FILE_ATTRIBUTE_COMPRESSED,
    FILE_ATTRIBUTE_ENCRYPTED, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC,
};
use windows_sys::Win32::System::Memory::{LocalAlloc, LMEM_FIXED};
use windows_sys::Win32::System::SystemServices::FILE_PERSISTENT_ACLS;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::error::{AtlasError, ErrorKind};

struct LocalMemory(*mut c_void);

impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn last_error() -> AtlasError {
    std::io::Error::last_os_error().into()
}

fn sid_text(sid: *mut c_void) -> Result<String, AtlasError> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(last_error());
    }
    let _memory = LocalMemory(text.cast());
    let mut len = 0;
    unsafe {
        while *text.add(len) != 0 {
            len += 1;
        }
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
            text, len,
        )))
    }
}

fn current_user_sid() -> Result<String, AtlasError> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(error.into());
    }
    let memory = LocalMemory(unsafe { LocalAlloc(LMEM_FIXED, size as usize) });
    if memory.0.is_null() {
        return Err(last_error());
    }
    if unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, memory.0, size, &mut size) }
        == 0
    {
        return Err(last_error());
    }
    let user = unsafe { &*memory.0.cast::<TOKEN_USER>() };
    sid_text(user.User.Sid)
}

fn private_descriptor(user: &str) -> Result<LocalMemory, AtlasError> {
    let sddl: Vec<u16> = format!("O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(LocalMemory(descriptor))
}

fn open_path(path: &Path, directory: bool, change_permissions: bool) -> Result<File, AtlasError> {
    let access = READ_CONTROL
        | FILE_READ_ATTRIBUTES
        | if directory { FILE_LIST_DIRECTORY } else { 0 }
        | if change_permissions { WRITE_DAC } else { 0 };
    let mut options = OpenOptions::new();
    options
        .read(true)
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    options.custom_flags(
        FILE_FLAG_OPEN_REPARSE_POINT
            | if directory {
                FILE_FLAG_BACKUP_SEMANTICS
            } else {
                0
            },
    );
    let file = options.open(path)?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AtlasError::invalid(
            "The migration folder or disk was replaced by a link. Refresh before retrying.",
        ));
    }
    Ok(file)
}

fn require_supported_storage(file: &File) -> Result<(), AtlasError> {
    let mut flags = 0;
    if unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            &mut flags,
            null_mut(),
            0,
        )
    } == 0
    {
        return Err(last_error());
    }
    if flags & FILE_PERSISTENT_ACLS == 0 {
        return Err(AtlasError::invalid(
            "Choose a drive that supports Windows file permissions, such as NTFS.",
        ));
    }
    if file.metadata()?.file_attributes() & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED)
        != 0
    {
        return Err(AtlasError::invalid("Choose a folder without NTFS compression or file encryption for the virtual disk and backup."));
    }
    Ok(())
}

fn require_trusted_owner(file: &File, user: &str) -> Result<(), AtlasError> {
    let mut owner = null_mut();
    let mut descriptor = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if error != 0 {
        return Err(std::io::Error::from_raw_os_error(error as i32).into());
    }
    let _descriptor = LocalMemory(descriptor);
    let owner = sid_text(owner)?;
    if owner != user && owner != "S-1-5-18" && owner != "S-1-5-32-544" {
        return Err(AtlasError::new(ErrorKind::Permission, "The migration folder or disk is owned by another Windows account.")
            .hint("Choose an empty folder owned by your Windows account. Migration does not take ownership of other users' files."));
    }
    Ok(())
}

fn apply_private_permissions(file: &File, user: &str) -> Result<(), AtlasError> {
    require_trusted_owner(file, user)?;
    let descriptor = private_descriptor(user)?;
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = null_mut();
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) }
        == 0
    {
        return Err(last_error());
    }
    if present == 0 || acl.is_null() {
        return Err(AtlasError::invalid(
            "Could not establish private migration permissions.",
        ));
    }
    let error = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        )
    };
    if error != 0 {
        return Err(std::io::Error::from_raw_os_error(error as i32).into());
    }
    Ok(())
}

pub fn secure_destination(path: &Path) -> Result<File, AtlasError> {
    let file = open_path(path, true, true)?;
    require_supported_storage(&file)?;
    if !file.metadata()?.is_dir() || fs::read_dir(path)?.next().transpose()?.is_some() {
        return Err(AtlasError::invalid(
            "The destination must still be an empty folder before permissions are changed.",
        ));
    }
    apply_private_permissions(&file, &current_user_sid()?)?;
    Ok(file)
}

pub fn create_private_directory(path: &Path) -> Result<File, AtlasError> {
    let parent = path
        .parent()
        .ok_or_else(|| AtlasError::invalid("The backup needs a parent folder."))?;
    let _parent_guard = open_path(parent, true, false)?;
    require_supported_storage(&_parent_guard)?;
    let descriptor = private_descriptor(&current_user_sid()?)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        return Err(last_error());
    }
    let file = open_path(path, true, false)?;
    require_supported_storage(&file)?;
    Ok(file)
}

pub fn secure_disk(path: &Path) -> Result<(), AtlasError> {
    let file = open_path(path, false, true)?;
    secure_disk_handle(&file)
}

pub fn secure_disk_handle(file: &File) -> Result<(), AtlasError> {
    if !file.metadata()?.is_file() {
        return Err(AtlasError::invalid(
            "The virtual disk is not a regular file.",
        ));
    }
    apply_private_permissions(file, &current_user_sid()?)
}
