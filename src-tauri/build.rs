use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const RELEASE_SOURCE_CHECKS: &[&str] = &[
    "scripts/check-filesystem-input-policy.mjs",
    "scripts/check-jsx-text-escapes.mjs",
    "scripts/check-path-display-graphemes.mjs",
];
const RUST_ONLY_RELEASE_ENV: &str = "AGENTS_UI_RUST_ONLY_RELEASE";

fn run_release_source_check(repository_root: &Path, relative_script: &str) {
    let script = repository_root.join(relative_script);
    let status = Command::new("node")
        .arg(&script)
        .current_dir(repository_root)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run release source check {}: {error}",
                script.display()
            )
        });
    assert!(
        status.success(),
        "release source check failed: {}",
        script.display()
    );
}

fn release_source_check_prerequisite_error(repository_root: &Path) -> Option<String> {
    if !repository_root.join("node_modules/typescript").is_dir() {
        return Some("the frontend TypeScript dependency is not installed".to_string());
    }

    match Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => None,
        Ok(status) => Some(format!("Node exited with status {status}")),
        Err(error) => Some(format!("Node is unavailable: {error}")),
    }
}

fn main() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must provide CARGO_MANIFEST_DIR"),
    );
    let repository_root = manifest_dir
        .parent()
        .expect("src-tauri must have a repository parent");

    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../node_modules/typescript/lib/typescript.js");
    println!("cargo:rerun-if-env-changed=PATH");
    println!("cargo:rerun-if-env-changed={RUST_ONLY_RELEASE_ENV}");
    for script in RELEASE_SOURCE_CHECKS {
        println!("cargo:rerun-if-changed=../{script}");
    }

    // Debug Cargo checks/tests remain Rust-only. Every release build fails
    // closed unless the frontend source contracts run successfully. A caller
    // that deliberately needs only the Rust binary may opt out explicitly;
    // packaging must never infer that intent merely from missing tooling.
    if env::var("PROFILE").as_deref() == Ok("release") {
        if env::var(RUST_ONLY_RELEASE_ENV).as_deref() == Ok("1") {
            println!(
                "cargo:warning=frontend release source checks explicitly skipped by {RUST_ONLY_RELEASE_ENV}=1"
            );
        } else if let Some(error) = release_source_check_prerequisite_error(repository_root) {
            panic!(
                "release source checks require Node and installed frontend dependencies: {error}. Set {RUST_ONLY_RELEASE_ENV}=1 only for a deliberate Rust-only release"
            );
        } else {
            for script in RELEASE_SOURCE_CHECKS {
                run_release_source_check(repository_root, script);
            }
        }
    }

    tauri_build::build()
}
