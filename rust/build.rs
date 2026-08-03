//! Bakes a fingerprint of the crate's own source into the binary.
//!
//! The binary is a build artifact that lives in git, because the marketplace
//! install path is `git clone` + copy and has no build step anywhere in it. That
//! arrangement has exactly one dangerous failure mode: edit `src/`, forget to
//! rebuild and re-copy, and every guard silently keeps running the old logic
//! while the source says otherwise. Nothing about the committed bytes reveals it.
//!
//! The obvious check — build in CI and `cmp` against the committed file — does
//! not work, because Rust builds are not bit-reproducible across toolchain
//! versions or build paths. A fingerprint sidesteps that entirely: CI builds
//! fresh and compares `--source-fingerprint` between the fresh and committed
//! binaries. Same source → same fingerprint, regardless of who compiled it or
//! with which rustc.
//!
//! FNV-1a, hand-rolled, because this needs to detect accidents rather than resist
//! attack, and a build-dependency for that would be absurd.

use std::path::PathBuf;

fn fnv1a(acc: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *acc ^= *b as u64;
        *acc = acc.wrapping_mul(0x100_0000_01b3);
    }
}

fn main() {
    let mut paths: Vec<PathBuf> = std::fs::read_dir("src")
        .expect("src/ must exist")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .collect();
    // Sorted so the fingerprint does not depend on filesystem iteration order.
    paths.sort();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for path in &paths {
        // Hash the name as well as the contents, so renaming a file or splitting
        // one in two changes the fingerprint even if the total bytes do not.
        fnv1a(&mut hash, path.file_name().unwrap_or_default().as_encoded_bytes());
        let contents = std::fs::read(path).unwrap_or_default();
        fnv1a(&mut hash, &contents);
        println!("cargo:rerun-if-changed={}", path.display());
    }

    println!("cargo:rustc-env=CCGUARD_SRC_FINGERPRINT={hash:016x}");
    println!("cargo:rerun-if-changed=build.rs");
}
