use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, KEY_ENUMERATE_SUB_KEYS, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

pub(crate) fn read_dword(root: HKEY, key: &str, value: &str) -> Option<u32> {
    let (key, value) = (wide(key), wide(value));
    let mut data = 0u32;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&raw mut data).cast(), &mut size)
    };
    (status == ERROR_SUCCESS).then_some(data)
}

pub(crate) fn read_text_value(root: HKEY, key: &str, value: &str) -> Option<String> {
    let (key, value) = (wide(key), wide(value));
    let mut size = 0u32;
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), data.as_mut_ptr().cast(), &mut size)
    };
    (status == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&data).trim_end_matches('\0').to_string())
}

/// The names of the keys directly under `key`, or None when `key` does not exist.
pub(crate) fn subkeys(root: HKEY, key: &str) -> Option<Vec<String>> {
    let key = wide(key);
    let mut handle: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(root, key.as_ptr(), 0, KEY_ENUMERATE_SUB_KEYS, &mut handle) } != ERROR_SUCCESS {
        return None;
    }
    let mut names = Vec::new();
    // Registry key names are limited to 255 characters.
    let mut name = [0u16; 256];
    for index in 0.. {
        let mut length = name.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                handle,
                index,
                name.as_mut_ptr(),
                &mut length,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            break;
        }
        names.push(String::from_utf16_lossy(&name[..length as usize]));
    }
    unsafe { RegCloseKey(handle) };
    Some(names)
}
