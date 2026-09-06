use crate::{Result, invalid};

#[cfg(any(target_os = "linux", test))]
fn parse_id(name: &str, value: Option<&str>) -> Result<u32> {
    let value = value.unwrap_or("10001");
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid(format!(
            "{name} must be an integer between 1 and 4294967294"
        ))
        .into());
    }
    match value.parse::<u32>() {
        Ok(id) if id != 0 && id != u32::MAX => Ok(id),
        _ => Err(invalid(format!(
            "{name} must be an integer between 1 and 4294967294"
        ))
        .into()),
    }
}

// Keep the named account consistent with process credentials: initdb resolves
// the effective UID through /etc/passwd even when its database user is explicit.
#[cfg(any(target_os = "linux", test))]
fn account_file(contents: &str, uid: u32, gid: Option<u32>) -> Result<String> {
    let mut found = false;
    let mut result = String::new();
    for line in contents.lines() {
        let mut fields: Vec<String> = line.split(':').map(str::to_owned).collect();
        if fields.len() != if gid.is_some() { 7 } else { 4 } {
            return Err(invalid("invalid appliance account file").into());
        }
        if fields[0] == "neoseq" {
            if found {
                return Err(invalid("duplicate neoseq account").into());
            }
            found = true;
            fields[2] = uid.to_string();
            if let Some(gid) = gid {
                fields[3] = gid.to_string();
            }
        } else if fields[2].parse::<u32>().ok() == Some(uid) {
            return Err(invalid(format!("identity {uid} already belongs to {}", fields[0])).into());
        }
        result.push_str(&fields.join(":"));
        result.push('\n');
    }
    if !found {
        return Err(invalid("neoseq account is missing from the appliance image").into());
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
pub(super) fn enter(prepare: bool) -> Result<()> {
    use std::{env, fs, io, path::Path, process::Command};

    fn configured_id(name: &str) -> Result<u32> {
        match env::var(name) {
            Ok(value) => parse_id(name, Some(&value)),
            Err(env::VarError::NotPresent) => parse_id(name, None),
            Err(error) => Err(invalid(format!("invalid {name}: {error}")).into()),
        }
    }

    let uid = configured_id("PUID")?;
    let gid = configured_id("PGID")?;
    // SAFETY: these calls only read this process's credentials.
    let (current_uid, current_gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    if current_uid != 0 && (current_uid != uid || current_gid != gid) {
        return Err(invalid("PUID/PGID differ from the process identity; start the container with its default user to prepare ownership").into());
    }

    let passwd = fs::read_to_string("/etc/passwd")?;
    let group = fs::read_to_string("/etc/group")?;
    let configured_passwd = account_file(&passwd, uid, Some(gid))?;
    let configured_group = account_file(&group, gid, None)?;

    if current_uid == 0 && prepare {
        let directories = ["/var/lib/neoseq", "/backups", "/run/neoseq", "/home/neoseq"];
        for directory in directories {
            match fs::symlink_metadata(Path::new(directory)) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(invalid(format!(
                        "managed directory must not be a symlink: {directory}"
                    ))
                    .into());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir_all(directory)?
                }
                Err(error) => return Err(error.into()),
            }
        }
        // Do not traverse symlinks into directories outside the managed roots.
        let status = Command::new("/bin/chown")
            .args(["-R", "-P", "--no-dereference", "--preserve-root"])
            .arg(format!("{uid}:{gid}"))
            .arg("--")
            .args(directories)
            .status()?;
        if !status.success() {
            return Err(invalid(format!(
                "could not prepare appliance directory ownership: {status}"
            ))
            .into());
        }
        if passwd != configured_passwd {
            fs::write("/etc/passwd", configured_passwd)?;
        }
        if group != configured_group {
            fs::write("/etc/group", configured_group)?;
        }
    } else if passwd != configured_passwd || group != configured_group {
        return Err(invalid("PUID/PGID do not match the initialized appliance account; recreate the container with the requested identity").into());
    }

    if current_uid == 0 {
        // SAFETY: main calls this before creating any threads or children.
        // Clear supplementary groups first, then permanently drop root.
        unsafe {
            if libc::setgroups(0, std::ptr::null()) != 0
                || libc::setgid(gid) != 0
                || libc::setuid(uid) != 0
            {
                return Err(io::Error::last_os_error().into());
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn enter(_prepare: bool) -> Result<()> {
    Err(invalid("the Neoseq appliance requires Linux").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/false\nneoseq:x:10001:10001:Neoseq appliance:/home/neoseq:/bin/false\n";
    const GROUP: &str = "root:x:0:\nneoseq:x:10001:\n";

    #[test]
    fn defaults_and_explicit_ids() {
        assert_eq!(parse_id("PUID", None).unwrap(), 10001);
        assert_eq!(parse_id("PUID", Some("12345")).unwrap(), 12345);
        assert_eq!(parse_id("PGID", Some("23456")).unwrap(), 23456);
        assert_eq!(parse_id("PUID", Some("4294967294")).unwrap(), u32::MAX - 1);
    }

    #[test]
    fn rejects_root_sentinel_and_malformed_ids() {
        for value in [
            "",
            "0",
            "-1",
            "+1",
            " 1000",
            "1000 ",
            "user",
            "4294967295",
            "4294967296",
        ] {
            assert!(parse_id("PUID", Some(value)).is_err(), "{value}");
        }
    }

    #[test]
    fn updates_only_the_neoseq_account_and_preserves_its_name() {
        let passwd = account_file(PASSWD, 12345, Some(23456)).unwrap();
        assert_eq!(passwd, PASSWD.replace("10001:10001", "12345:23456"));
        assert_eq!(account_file(&passwd, 12345, Some(23456)).unwrap(), passwd);
        assert_eq!(
            account_file(GROUP, 23456, None).unwrap(),
            GROUP.replace("10001", "23456")
        );
    }

    #[test]
    fn rejects_missing_duplicate_malformed_and_conflicting_accounts() {
        assert!(account_file("root:x:0:\n", 12345, None).is_err());
        assert!(account_file(&(GROUP.to_owned() + GROUP), 12345, None).is_err());
        assert!(account_file("neoseq\n", 12345, None).is_err());
        assert!(account_file(&(GROUP.to_owned() + "other:x:12345:\n"), 12345, None).is_err());
    }
}
