use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand_core::{OsRng, RngCore};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri::WebviewWindow;

const KEYCHAIN_ACCOUNT: &str = "agents-ui-data-key-v1";
const ENC_PREFIX: &str = "enc:v1:";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

pub enum SecretContext {
    State,
    Recording,
}

impl SecretContext {
    fn aad(&self) -> &'static [u8] {
        match self {
            SecretContext::State => b"agents-ui/state/v1",
            SecretContext::Recording => b"agents-ui/recording/v1",
        }
    }
}

pub fn is_encrypted_value(value: &str) -> bool {
    value.trim_start().starts_with(ENC_PREFIX)
}

/// Returns true only if the value both has the `enc:v1:` prefix and contains a plausibly-sized
/// base64-encoded (nonce + ciphertext) blob.
///
/// This avoids triggering Keychain reads for plain text that happens to start with the prefix.
pub fn is_probably_encrypted_value(value: &str) -> bool {
    if !is_encrypted_value(value) {
        return false;
    }
    let trimmed = value.trim_start();
    let encoded = trimmed.strip_prefix(ENC_PREFIX).unwrap_or_default();
    let decoded = match BASE64.decode(encoded) {
        Ok(decoded) => decoded,
        Err(_) => return false,
    };
    // Nonce (12 bytes) + Poly1305 tag (16 bytes) at minimum.
    decoded.len() >= NONCE_LEN + 16
}

#[derive(Clone)]
enum MasterKeyCacheState {
    Uninitialized,
    Ready([u8; KEY_LEN]),
    Error(String),
}

fn master_key_cache() -> &'static Mutex<MasterKeyCacheState> {
    static CACHE: OnceLock<Mutex<MasterKeyCacheState>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(MasterKeyCacheState::Uninitialized))
}

fn keychain_service(window: &WebviewWindow) -> String {
    let app = window.app_handle();
    let cfg = app.config();
    cfg.identifier.clone()
}

fn get_or_create_master_key_uncached(window: &WebviewWindow) -> Result<[u8; KEY_LEN], String> {
    let service = keychain_service(window);
    let entry = keyring::Entry::new(&service, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keychain init failed: {e}"))?;

    match entry.get_password() {
        Ok(encoded) => {
            let decoded = BASE64
                .decode(encoded.trim())
                .map_err(|e| format!("invalid keychain key encoding: {e}"))?;
            if decoded.len() != KEY_LEN {
                return Err("invalid keychain key length".to_string());
            }
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&decoded);
            return Ok(key);
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("keychain read failed: {e}")),
    }

    let mut key = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key);
    let encoded = BASE64.encode(key);

    entry
        .set_password(&encoded)
        .map_err(|e| format!("keychain write failed: {e}"))?;
    Ok(key)
}

pub fn get_or_create_master_key(window: &WebviewWindow) -> Result<[u8; KEY_LEN], String> {
    let cache = master_key_cache();
    let mut state = cache.lock().map_err(|_| "secure storage cache poisoned".to_string())?;
    match &*state {
        MasterKeyCacheState::Ready(key) => return Ok(*key),
        MasterKeyCacheState::Error(err) => return Err(err.clone()),
        MasterKeyCacheState::Uninitialized => {}
    }

    match get_or_create_master_key_uncached(window) {
        Ok(key) => {
            *state = MasterKeyCacheState::Ready(key);
            Ok(key)
        }
        Err(err) => {
            // Cache the error to avoid repeated Keychain prompts/spam until the user explicitly retries.
            *state = MasterKeyCacheState::Error(err.clone());
            Err(err)
        }
    }
}

pub fn reset_master_key_cache() -> Result<(), String> {
    let cache = master_key_cache();
    let mut state = cache.lock().map_err(|_| "secure storage cache poisoned".to_string())?;
    *state = MasterKeyCacheState::Uninitialized;
    Ok(())
}

#[tauri::command]
pub fn prepare_secure_storage(window: WebviewWindow) -> Result<(), String> {
    let _ = get_or_create_master_key(&window)?;
    Ok(())
}

#[tauri::command]
pub fn reset_secure_storage() -> Result<(), String> {
    reset_master_key_cache()
}

pub fn encrypt_string_with_key(
    key: &[u8; KEY_LEN],
    context: SecretContext,
    plaintext: &str,
) -> Result<String, String> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: context.aad(),
            },
        )
        .map_err(|e| format!("encrypt failed: {e}"))?;

    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(format!("{ENC_PREFIX}{}", BASE64.encode(blob)))
}

pub fn decrypt_string_with_key(
    key: &[u8; KEY_LEN],
    context: SecretContext,
    value: &str,
) -> Result<String, String> {
    let trimmed = value.trim_start();
    if !trimmed.starts_with(ENC_PREFIX) {
        return Ok(value.to_string());
    }

    let encoded = trimmed.strip_prefix(ENC_PREFIX).unwrap_or_default();
    let decoded = match BASE64.decode(encoded) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(value.to_string()),
    };
    if decoded.len() < NONCE_LEN {
        return Ok(value.to_string());
    }
    let (nonce_bytes, ciphertext) = decoded.split_at(NONCE_LEN);

    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad: context.aad(),
            },
        )
        .map_err(|e| format!("decrypt failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("decrypt failed (utf8): {e}"))
}
