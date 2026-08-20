//! Does an installed Mach-O executable declare a dependency that is not there?
//!
//! A requirement compiled on this machine can be present, executable, and still
//! unable to start: whisper.cpp links its libraries dynamically by default and
//! records an `LC_RPATH` naming the build directory, which the installer deletes
//! as soon as the build finishes. The file survives; the libraries do not, and
//! dyld kills the process before `main`.
//!
//! **What [`Linkage::Resolved`] does and does not mean.** It means every dylib
//! this image *directly* declares was located. It is not a promise that the
//! binary launches. This deliberately does not walk the dependency graph, model
//! `DYLD_*` overrides, check code signatures or library validation, compare
//! architectures, or verify that a located file is a loadable Mach-O of the
//! right kind. Only dyld can answer that, and only by running the thing — which
//! is why the installer launches the artefact once, at install time
//! (`requirement_source_build.rs`), and this cheap screen is what the recurring
//! polls use afterwards.
//!
//! **Why it reads rather than runs.** The recurring check fires on every skill
//! listing and every chat turn, over a file in a user-writable directory.
//! Executing that file is ambient code execution with the app's authority, and
//! `--version` constrains nothing about what the program does; a timeout cannot
//! undo a side effect. The process cost is the smaller objection.
//!
//! Whenever it cannot answer, it says [`Linkage::Undetermined`] — never
//! `Resolved`. A caller must not read "could not tell" as "fine".

use object::macho::{DYLIB_USE_WEAK_LINK, LC_LOAD_WEAK_DYLIB};
use object::read::macho::{FatArch, LoadCommandVariant, MachHeader, MachOFatFile, MachOFile};
use object::read::ReadCache;
use object::{Architecture, Endianness, FileKind, ReadRef};
use std::path::{Path, PathBuf};

/// Refuse to inspect anything larger than this. `object` reads a universal
/// binary's selected slice whole, and a fat header carries an attacker-chosen
/// 64-bit slice size, so an unbounded read is an out-of-memory abort waiting to
/// happen. Real requirement executables are single-digit to tens of megabytes.
const MAX_INSPECTED_BYTES: u64 = 512 * 1024 * 1024;

/// What reading an installed executable's load commands established.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Linkage {
    /// Every dylib the image directly declares was located.
    Resolved,
    /// Directly declared dylibs that nothing satisfies, in declaration order. A
    /// launch fails in dyld with "Library not loaded" naming one of these.
    Unresolved(Vec<String>),
    /// The file could not be read, or is not a Mach-O image this can judge.
    Undetermined(String),
}

/// Read `binary`'s load commands and report whether its dependencies are there.
pub(crate) fn inspect(binary: &Path) -> Linkage {
    let Some(loader_dir) = binary.parent().map(Path::to_path_buf) else {
        return Linkage::Undetermined("the executable has no parent directory".into());
    };
    let file = match std::fs::File::open(binary) {
        Ok(file) => file,
        Err(error) => return Linkage::Undetermined(format!("could not open the file: {error}")),
    };
    match file.metadata().map(|metadata| metadata.len()) {
        Ok(size) if size > MAX_INSPECTED_BYTES => {
            return Linkage::Undetermined(format!(
                "the file is too large to inspect ({size} bytes)"
            ))
        }
        Ok(_) => {}
        Err(error) => return Linkage::Undetermined(format!("could not size the file: {error}")),
    }
    let cache = ReadCache::new(file);
    match FileKind::parse(&cache) {
        Ok(FileKind::MachOFat32) => inspect_fat::<object::macho::FatArch32>(&cache, &loader_dir),
        Ok(FileKind::MachOFat64) => inspect_fat::<object::macho::FatArch64>(&cache, &loader_dir),
        _ => inspect_thin(&cache, &loader_dir),
    }
}

/// Judge one thin Mach-O image, whichever width and byte order it is.
fn inspect_thin<'data, R: ReadRef<'data>>(data: R, loader_dir: &Path) -> Linkage {
    match FileKind::parse(data) {
        Ok(FileKind::MachO32) => {
            inspect_image::<object::macho::MachHeader32<Endianness>, _>(data, loader_dir)
        }
        Ok(FileKind::MachO64) => {
            inspect_image::<object::macho::MachHeader64<Endianness>, _>(data, loader_dir)
        }
        Ok(_) => Linkage::Undetermined("the file is not a Mach-O executable".into()),
        Err(error) => Linkage::Undetermined(format!("could not read the image header: {error}")),
    }
}

/// Judge the slice of a universal binary this machine is most likely to run.
///
/// Architecture is deliberately not a verdict: Rosetta 2 runs an x86_64 image on
/// Apple Silicon, and the thin path applies no architecture rule either, so
/// condemning a universal binary for lacking a native slice would contradict it.
/// The host slice is preferred and the first slice is the fallback. Where a fat
/// file carries both `arm64` and `arm64e`, `object` reports one `Architecture`
/// for both and the first is taken, which may not be the one dyld would pick.
fn inspect_fat<Fat: FatArch>(cache: &ReadCache<std::fs::File>, loader_dir: &Path) -> Linkage {
    let fat = match MachOFatFile::<'_, Fat>::parse(cache) {
        Ok(fat) => fat,
        Err(error) => return Linkage::Undetermined(format!("invalid universal binary: {error}")),
    };
    let arches = fat.arches();
    let Some(slice) = arches
        .iter()
        .find(|arch| arch.architecture() == host_architecture())
        .or_else(|| arches.first())
    else {
        return Linkage::Undetermined("the universal binary contains no images".into());
    };
    if slice.size().into() > MAX_INSPECTED_BYTES {
        return Linkage::Undetermined("a universal binary slice is too large to inspect".into());
    }
    match slice.data(cache) {
        Ok(data) => inspect_thin(data, loader_dir),
        Err(error) => Linkage::Undetermined(format!("invalid universal slice: {error}")),
    }
}

fn inspect_image<'data, Mach, R>(data: R, loader_dir: &Path) -> Linkage
where
    Mach: MachHeader<Endian = Endianness>,
    R: ReadRef<'data>,
{
    let declared = match read_declared_dependencies::<Mach, R>(data) {
        Ok(declared) => declared,
        Err(reason) => return Linkage::Undetermined(reason),
    };
    let unresolved: Vec<String> = declared
        .required
        .into_iter()
        .filter(|name| !resolves(name, &declared.run_paths, loader_dir))
        .collect();
    if unresolved.is_empty() {
        Linkage::Resolved
    } else {
        Linkage::Unresolved(unresolved)
    }
}

/// The dependency names and run paths an image declares.
struct DeclaredDependencies {
    run_paths: Vec<String>,
    required: Vec<String>,
}

/// Read the load commands, or say why the question cannot be answered.
///
/// A string that cannot be read ends the whole reading rather than being skipped.
/// A dropped *dependency* would shorten the list the verdict is computed from and
/// report a broken image as resolved; a dropped *run path* would hide the
/// libraries it would have found and report a healthy one as broken.
fn read_declared_dependencies<'data, Mach, R>(data: R) -> Result<DeclaredDependencies, String>
where
    Mach: MachHeader<Endian = Endianness>,
    R: ReadRef<'data>,
{
    let image = MachOFile::<Mach, R>::parse(data)
        .map_err(|error| format!("invalid Mach-O image: {error}"))?;
    let endian = image.endian();
    let mut commands = image
        .macho_load_commands()
        .map_err(|error| format!("invalid load commands: {error}"))?;
    let mut declared = DeclaredDependencies {
        run_paths: Vec::new(),
        required: Vec::new(),
    };
    while let Some(command) = commands
        .next()
        .map_err(|error| format!("invalid load command: {error}"))?
    {
        match command
            .variant()
            .map_err(|error| format!("invalid load command payload: {error}"))?
        {
            LoadCommandVariant::Rpath(rpath) => {
                let path = command
                    .string(endian, rpath.path)
                    .ok()
                    .and_then(as_text)
                    .ok_or("a run path could not be read")?;
                declared.run_paths.push(path);
            }
            LoadCommandVariant::Dylib(dylib) if !is_weak(&command, endian, dylib) => {
                let name = command
                    .string(endian, dylib.dylib.name)
                    .ok()
                    .and_then(as_text)
                    .ok_or("a library name could not be read")?;
                declared.required.push(name);
            }
            _ => {}
        }
    }
    Ok(declared)
}

/// A weak dylib may be absent without consequence — dyld nulls its symbols and
/// the process still starts.
///
/// `LoadCommandVariant::Dylib` covers five command types, and weakness has two
/// encodings: the classic `LC_LOAD_WEAK_DYLIB`, and, since the macOS 15 SDK, a
/// flag inside an `LC_LOAD_DYLIB` that carries a `DylibUseCommand` bitfield.
/// Reading only the first would treat a modern weak link as a hard requirement
/// and condemn a binary that launches perfectly well.
///
/// The remaining kinds — reexport, upward, and lazy — are treated as required.
/// That is stricter than dyld for the lazy one, which fails only when a symbol
/// from it is first used: for a single-purpose transcription CLI that is a
/// failure mid-transcription rather than at launch, and the app would rather
/// decline to call it ready.
fn is_weak<E: object::Endian>(
    command: &object::read::macho::LoadCommandData<'_, E>,
    endian: E,
    dylib: &object::macho::DylibCommand<E>,
) -> bool {
    if command.cmd() == LC_LOAD_WEAK_DYLIB {
        return true;
    }
    command
        .dylib_use_flags(endian, dylib)
        .ok()
        .flatten()
        .is_some_and(|flags| flags.0 & DYLIB_USE_WEAK_LINK.0 != 0)
}

/// Can `name` be located, given this image's run paths?
fn resolves(name: &str, run_paths: &[String], loader_dir: &Path) -> bool {
    if served_by_the_shared_cache(name) {
        return true;
    }
    let Some(relative) = name.strip_prefix("@rpath/") else {
        return expand(name, loader_dir).is_some_and(|path| locatable(&path));
    };
    // `@rpath//libX.dylib` leaves a leading slash, and joining an absolute path
    // would silently discard the run path it was supposed to be relative to.
    let relative = relative.trim_start_matches('/');
    run_paths.iter().any(|run_path| {
        expand(run_path, loader_dir).is_some_and(|directory| {
            let candidate = directory.join(relative);
            locatable(&candidate)
        })
    })
}

/// Ask dyld itself whether a path is served from the shared cache, rather than
/// guessing from a prefix.
///
/// This matters in both directions. Libraries under `/usr/lib` and `/System` are
/// genuinely absent from the filesystem on macOS 11 and later, so checking the
/// disk would condemn every healthy binary on the machine — but those prefixes
/// also contain ordinary files that are *not* cached, and an `@rpath` candidate
/// that merely lands under one of them is not cached at all. A prefix allowlist
/// gets both wrong, and gets them wrong in the fail-open direction.
#[cfg(target_os = "macos")]
fn served_by_the_shared_cache(path: &str) -> bool {
    extern "C" {
        /// `<mach-o/dyld.h>`, available since macOS 11.
        fn _dyld_shared_cache_contains_path(path: *const libc::c_char) -> bool;
    }

    let Ok(path) = std::ffi::CString::new(path) else {
        return false;
    };
    // SAFETY: the argument is a live NUL-terminated string for the duration of
    // the call, and dyld does not retain it.
    unsafe { _dyld_shared_cache_contains_path(path.as_ptr()) }
}

/// Expand the two load-time prefixes dyld substitutes, or report that the path
/// cannot be located at all.
///
/// `None` covers two shapes deliberately. An unrecognised `@` token
/// (`@loader_pathology/x`, a chained `@rpath` inside a run path) is not
/// something dyld would expand the way a naive prefix match would. A path still
/// relative after expansion is resolved by dyld against the *process's* working
/// directory — whatever the launcher happened to set — so answering from the
/// directory this process happens to sit in would be a coin toss.
fn expand(path: &str, loader_dir: &Path) -> Option<PathBuf> {
    for prefix in ["@loader_path", "@executable_path"] {
        if let Some(relative) = path.strip_prefix(prefix) {
            // Require a token boundary: `@loader_pathology` is not `@loader_path`.
            if relative.is_empty() {
                return Some(loader_dir.to_path_buf());
            }
            if let Some(relative) = relative.strip_prefix('/') {
                return Some(loader_dir.join(relative.trim_start_matches('/')));
            }
            return None;
        }
    }
    if path.starts_with('@') {
        return None;
    }
    let path = PathBuf::from(path);
    path.is_absolute().then_some(path)
}

/// Deliberately follows symbolic links, because dyld does: a library reached
/// through a link loads, and one whose link dangles does not. `symlink_metadata`
/// — the right call everywhere this codebase guards a trusted root — would call
/// a dangling link "present" and clear a binary that cannot start.
fn locatable(path: &Path) -> bool {
    served_by_the_shared_cache(&path.to_string_lossy()) || path.metadata().is_ok()
}

/// Load-command strings are NUL-padded bytes with no encoding guarantee. A path
/// that is not UTF-8 cannot be compared against anything here; callers treat
/// that as an unanswerable question rather than converting it lossily into a
/// path that was never on disk.
fn as_text(bytes: &[u8]) -> Option<String> {
    std::str::from_utf8(bytes).ok().map(str::to_owned)
}

fn host_architecture() -> Architecture {
    if cfg!(target_arch = "aarch64") {
        Architecture::Aarch64
    } else {
        Architecture::X86_64
    }
}

#[cfg(test)]
#[path = "macho_linkage_tests.rs"]
mod tests;
