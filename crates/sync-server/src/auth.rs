use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Principal {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AuthError {
    #[error("authentication token is invalid")]
    Invalid,
}

/// Identity-provider seam. Production deployments supply their verifier as an
/// adapter; the repository includes only the deterministic test issuer.
pub trait TokenVerifier: Send + Sync + 'static {
    fn verify(&self, token: &str) -> Result<Principal, AuthError>;
}

#[derive(Clone)]
pub struct TestIssuer {
    secret: Arc<[u8]>,
}

impl TestIssuer {
    pub fn new(secret: impl AsRef<[u8]>) -> Result<Self, AuthError> {
        let secret = secret.as_ref();
        if secret.len() < 16 {
            return Err(AuthError::Invalid);
        }
        Ok(Self {
            secret: Arc::from(secret),
        })
    }

    pub fn issue(&self, principal_id: &str) -> Result<String, AuthError> {
        validate_principal(principal_id)?;
        let encoded = URL_SAFE_NO_PAD.encode(principal_id.as_bytes());
        let signature = self.sign(encoded.as_bytes());
        Ok(format!("test.{encoded}.{signature}"))
    }

    fn sign(&self, value: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts any key size");
        mac.update(value);
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }
}

impl TokenVerifier for TestIssuer {
    fn verify(&self, token: &str) -> Result<Principal, AuthError> {
        let mut parts = token.split('.');
        let (Some("test"), Some(encoded), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(AuthError::Invalid);
        };
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| AuthError::Invalid)?;
        let mut mac = HmacSha256::new_from_slice(&self.secret).map_err(|_| AuthError::Invalid)?;
        mac.update(encoded.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| AuthError::Invalid)?;
        let principal = URL_SAFE_NO_PAD
            .decode(encoded)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or(AuthError::Invalid)?;
        validate_principal(&principal)?;
        Ok(Principal { id: principal })
    }
}

fn validate_principal(value: &str) -> Result<(), AuthError> {
    if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
        Err(AuthError::Invalid)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokens_are_signed_and_tamper_evident() {
        let issuer = TestIssuer::new(b"0123456789abcdef").unwrap();
        let token = issuer.issue("principal-a").unwrap();
        assert_eq!(issuer.verify(&token).unwrap().id, "principal-a");
        assert_eq!(issuer.verify(&(token + "x")), Err(AuthError::Invalid));
    }
}
