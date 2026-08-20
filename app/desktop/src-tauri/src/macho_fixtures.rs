//! Synthetic Mach-O images for tests.
//!
//! Building the bytes by hand keeps a real 3 MB executable out of the repository
//! and makes the adversarial cases — unreadable name offsets, non-UTF-8 paths,
//! impossible command counts — expressible at all. The ground-truth tie-in is
//! the opt-in live harness in `requirement_source_build_live.rs`, which runs the
//! same inspection over the artefact a real build produces; these fixtures alone
//! would only prove the reader agrees with this file's idea of the format.

const MH_MAGIC_64: u32 = 0xfeed_facf;
const FAT_MAGIC: u32 = 0xcafe_babe;
const CPU_TYPE_ARM64: u32 = 0x0100_000c;
const CPU_TYPE_X86_64: u32 = 0x0100_0007;
const MH_EXECUTE: u32 = 2;
const LC_LOAD_DYLIB: u32 = 0x0000_000c;
const LC_LOAD_WEAK_DYLIB: u32 = 0x8000_0018;
const LC_RPATH: u32 = 0x8000_001c;
const COMMAND_ALIGNMENT: usize = 8;
/// `macho::DYLIB_USE_MARKER` — the sentinel that says a `LC_LOAD_DYLIB` carries
/// the macOS 15 `DylibUseCommand` flag bitfield instead of a timestamp.
const DYLIB_USE_MARKER: u32 = 0x1a74_1800;
const DYLIB_USE_WEAK_LINK: u32 = 0x01;

/// The six libraries a default (shared) whisper.cpp build makes `whisper-cli`
/// depend on, reached through an `LC_RPATH` naming the staging build directory
/// the installer deletes.
pub(crate) const WHISPER_DYLIBS: &[&str] = &[
    "@rpath/libwhisper.1.dylib",
    "@rpath/libggml.0.dylib",
    "@rpath/libggml-cpu.0.dylib",
    "@rpath/libggml-blas.0.dylib",
    "@rpath/libggml-metal.0.dylib",
    "@rpath/libggml-base.0.dylib",
];

/// What the fixed build produces: only libraries macOS itself ships, no rpaths.
pub(crate) const SYSTEM_DYLIBS: &[&str] = &[
    "/usr/lib/libSystem.B.dylib",
    "/usr/lib/libc++.1.dylib",
    "/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate",
];

/// The architecture this test binary runs as, and one it certainly does not.
pub(crate) const HOST_CPU_TYPE: u32 = if cfg!(target_arch = "aarch64") {
    CPU_TYPE_ARM64
} else {
    CPU_TYPE_X86_64
};
pub(crate) const FOREIGN_CPU_TYPE: u32 = if cfg!(target_arch = "aarch64") {
    CPU_TYPE_X86_64
} else {
    CPU_TYPE_ARM64
};

/// A 64-bit executable for this machine, declaring the given dependencies and
/// run paths.
pub(crate) fn executable(dylibs: &[&str], weak_dylibs: &[&str], rpaths: &[&str]) -> Vec<u8> {
    executable_for(HOST_CPU_TYPE, dylibs, weak_dylibs, rpaths)
}

/// A 64-bit executable for a named architecture.
pub(crate) fn executable_for(
    cpu_type: u32,
    dylibs: &[&str],
    weak_dylibs: &[&str],
    rpaths: &[&str],
) -> Vec<u8> {
    let mut commands = Vec::new();
    for name in dylibs {
        commands.push(dylib_command(LC_LOAD_DYLIB, name.as_bytes()));
    }
    for name in weak_dylibs {
        commands.push(dylib_command(LC_LOAD_WEAK_DYLIB, name.as_bytes()));
    }
    // Real linkers emit the run paths after the libraries that use them, so the
    // fixture does too — resolution must not depend on the order.
    for path in rpaths {
        commands.push(rpath_command(path));
    }
    image_with(cpu_type, &commands)
}

/// An executable whose one dependency is weak-linked the way the macOS 15 SDK
/// encodes it: an ordinary `LC_LOAD_DYLIB` carrying a `DylibUseCommand` bitfield.
pub(crate) fn executable_with_modern_weak_link(name: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for word in [
        LC_LOAD_DYLIB,
        0,  // cmdsize, patched once the string is appended
        28, // the sentinel name offset that marks the new encoding
        DYLIB_USE_MARKER,
        0, // current_version
        0, // compatibility_version
        DYLIB_USE_WEAK_LINK,
    ] {
        body.extend_from_slice(&word.to_le_bytes());
    }
    append_padded_string(&mut body, name.as_bytes());
    image_with(HOST_CPU_TYPE, &[body])
}

/// An executable declaring one dependency whose name cannot be read: the name
/// offset points past the end of its own load command.
pub(crate) fn executable_with_unreadable_dylib_name() -> Vec<u8> {
    let mut body = Vec::new();
    for word in [LC_LOAD_DYLIB, 0, 4096, 0, 0, 0] {
        body.extend_from_slice(&word.to_le_bytes());
    }
    append_padded_string(&mut body, b"/usr/lib/libSystem.B.dylib");
    image_with(HOST_CPU_TYPE, &[body])
}

/// An executable with one `@rpath` dependency and one run path whose own string
/// cannot be read, because its offset points past the end of its load command.
pub(crate) fn executable_with_unreadable_run_path() -> Vec<u8> {
    let mut run_path = Vec::new();
    for word in [LC_RPATH, 0, 4096] {
        run_path.extend_from_slice(&word.to_le_bytes());
    }
    append_padded_string(&mut run_path, b"/opt/whisper/lib");
    image_with(
        HOST_CPU_TYPE,
        &[
            dylib_command(LC_LOAD_DYLIB, b"@rpath/libwhisper.1.dylib"),
            run_path,
        ],
    )
}

/// An executable declaring one dependency whose name is not valid UTF-8.
pub(crate) fn executable_with_non_utf8_dylib_name() -> Vec<u8> {
    image_with(
        HOST_CPU_TYPE,
        &[dylib_command(
            LC_LOAD_DYLIB,
            b"/opt/\xff\xfe/libbroken.dylib",
        )],
    )
}

/// A universal binary wrapping one image per architecture, laid out the way
/// `lipo` lays one out: the arch table first, then each slice on its own
/// alignment boundary.
pub(crate) fn universal(slices: &[(u32, Vec<u8>)]) -> Vec<u8> {
    const SLICE_ALIGNMENT: usize = 1 << 14;

    let mut offset = SLICE_ALIGNMENT;
    let mut placed = Vec::new();
    for (cpu_type, slice) in slices {
        placed.push((*cpu_type, offset, slice));
        offset += slice.len().next_multiple_of(SLICE_ALIGNMENT);
    }
    let mut image = Vec::new();
    image.extend_from_slice(&FAT_MAGIC.to_be_bytes());
    image.extend_from_slice(&(slices.len() as u32).to_be_bytes());
    for (cpu_type, offset, slice) in &placed {
        // fat_arch is big-endian whatever the slices inside it are.
        for word in [*cpu_type, 0, *offset as u32, slice.len() as u32, 14] {
            image.extend_from_slice(&word.to_be_bytes());
        }
    }
    for (_, offset, slice) in &placed {
        image.resize(*offset, 0);
        image.extend_from_slice(slice);
    }
    image
}

fn image_with(cpu_type: u32, commands: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = commands.concat();
    let mut image = Vec::new();
    for word in [
        MH_MAGIC_64,
        cpu_type,
        0, // cpusubtype
        MH_EXECUTE,
        commands.len() as u32,
        body.len() as u32,
        0, // flags
        0, // reserved
    ] {
        image.extend_from_slice(&word.to_le_bytes());
    }
    image.extend_from_slice(&body);
    image
}

fn dylib_command(command: u32, name: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    for word in [
        command, 0,  // cmdsize, patched once the string is appended
        24, // the name's offset from the start of this command
        0,  // timestamp
        0,  // current_version
        0,  // compatibility_version
    ] {
        body.extend_from_slice(&word.to_le_bytes());
    }
    append_padded_string(&mut body, name);
    body
}

fn rpath_command(path: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for word in [
        LC_RPATH, 0,  // cmdsize, patched once the string is appended
        12, // the path's offset from the start of this command
    ] {
        body.extend_from_slice(&word.to_le_bytes());
    }
    append_padded_string(&mut body, path.as_bytes());
    body
}

/// Append a NUL-terminated string, pad the command to its alignment, then write
/// the finished length into the `cmdsize` field the header reserved.
fn append_padded_string(body: &mut Vec<u8>, value: &[u8]) {
    body.extend_from_slice(value);
    body.push(0);
    while !body.len().is_multiple_of(COMMAND_ALIGNMENT) {
        body.push(0);
    }
    let size = (body.len() as u32).to_le_bytes();
    body[4..8].copy_from_slice(&size);
}
