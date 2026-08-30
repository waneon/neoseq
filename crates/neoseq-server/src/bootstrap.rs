use neoseq_server::PgIdentity;
use std::{env, ffi::OsString, fs, io, path::PathBuf};

const ADMIN_USERNAME: &str = "NEOSEQ_BOOTSTRAP_ADMIN_USERNAME";
const ADMIN_PASSWORD: &str = "NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD";
const ADMIN_PASSWORD_FILE: &str = "NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD_FILE";

struct BootstrapAdminConfig {
    username: String,
    password: BootstrapPassword,
}

enum BootstrapPassword {
    Value(String),
    File(PathBuf),
}

impl BootstrapAdminConfig {
    fn from_environment() -> io::Result<Option<Self>> {
        Self::from_values(
            env::var_os(ADMIN_USERNAME),
            env::var_os(ADMIN_PASSWORD),
            env::var_os(ADMIN_PASSWORD_FILE),
        )
    }

    fn from_values(
        username: Option<OsString>,
        password: Option<OsString>,
        password_file: Option<OsString>,
    ) -> io::Result<Option<Self>> {
        if username.is_none() && password.is_none() && password_file.is_none() {
            return Ok(None);
        }
        let Some(username) = username else {
            return Err(invalid_config(format!(
                "{ADMIN_USERNAME} is required when an initial administrator password is configured",
            )));
        };
        let username = username
            .into_string()
            .map_err(|_| invalid_config(format!("{ADMIN_USERNAME} must be valid UTF-8")))?;
        let password = match password_file {
            Some(path) => BootstrapPassword::File(PathBuf::from(path)),
            None => {
                let value = password.ok_or_else(|| {
                    invalid_config(format!(
                        "either {ADMIN_PASSWORD} or {ADMIN_PASSWORD_FILE} is required with {ADMIN_USERNAME}",
                    ))
                })?;
                BootstrapPassword::Value(
                    value.into_string().map_err(|_| {
                        invalid_config(format!("{ADMIN_PASSWORD} must be valid UTF-8"))
                    })?,
                )
            }
        };
        Ok(Some(Self { username, password }))
    }

    fn read_password(&self) -> io::Result<String> {
        match &self.password {
            BootstrapPassword::Value(value) => Ok(value.clone()),
            BootstrapPassword::File(path) => {
                let mut bytes = fs::read(path).map_err(|error| {
                    io::Error::new(
                        error.kind(),
                        format!("could not read {ADMIN_PASSWORD_FILE}: {error}"),
                    )
                })?;
                if bytes.ends_with(b"\r\n") {
                    bytes.truncate(bytes.len() - 2);
                } else if bytes.ends_with(b"\n") {
                    bytes.truncate(bytes.len() - 1);
                }
                String::from_utf8(bytes).map_err(|_| {
                    invalid_config(format!(
                        "{ADMIN_PASSWORD_FILE} must contain a UTF-8 password"
                    ))
                })
            }
        }
    }
}

pub(crate) async fn bootstrap_admin_from_environment(
    identity: &PgIdentity,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = BootstrapAdminConfig::from_environment()?;
    if identity.has_active_admin().await? {
        if config.is_some() {
            tracing::info!("initial administrator already exists; bootstrap configuration ignored");
        }
        return Ok(());
    }
    let Some(config) = config else {
        return Err(invalid_config(format!(
            "{ADMIN_USERNAME} and one administrator password source are required until the first administrator exists",
        ))
        .into());
    };
    let password = config.read_password()?;
    match identity
        .bootstrap_admin_if_absent(&config.username, &password)
        .await?
    {
        Some(account) => {
            tracing::info!(username = %account.username, "created initial administrator");
        }
        None => {
            tracing::info!("initial administrator was created by another server process");
        }
    }
    Ok(())
}

fn invalid_config(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn configuration_is_absent_when_no_values_are_set() {
        assert!(
            BootstrapAdminConfig::from_values(None, None, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn configuration_accepts_one_password_source() {
        let config = BootstrapAdminConfig::from_values(
            Some("admin".into()),
            Some("a deliberately long password".into()),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.username, "admin");
        assert_eq!(
            config.read_password().unwrap(),
            "a deliberately long password"
        );
    }

    #[test]
    fn configuration_rejects_partial_values() {
        let missing_password = BootstrapAdminConfig::from_values(Some("admin".into()), None, None)
            .err()
            .unwrap();
        assert_eq!(missing_password.kind(), io::ErrorKind::InvalidInput);

        let missing_username = BootstrapAdminConfig::from_values(
            None,
            Some("a deliberately long password".into()),
            None,
        )
        .err()
        .unwrap();
        assert_eq!(missing_username.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn password_file_takes_precedence_and_removes_one_line_ending() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "neoseq-bootstrap-password-{}-{suffix}",
            std::process::id()
        ));
        fs::write(&path, b"a password loaded from a secret\r\n").unwrap();
        let config = BootstrapAdminConfig::from_values(
            Some("admin".into()),
            Some("this value must be ignored".into()),
            Some(path.clone().into_os_string()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            config.read_password().unwrap(),
            "a password loaded from a secret"
        );
        fs::remove_file(path).unwrap();
    }
}
