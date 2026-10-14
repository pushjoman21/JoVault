"""Verify official crate archives and materialize the frozen patch in a NEW directory.

No downloads, Cargo changes or Rust execution. Requires git and Python 3.12+.
Trust the reviewed manifest by supplying its independently recorded SHA-256.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

UPSTREAM = "337a3668a0dc86dd401ea20906e782249a64a228"
CRATES = {
    "boa_engine-0.22.0": "5d6aaf7fdc4299df68adb67e1a5440a51d34630a1f5271b9698fd74bc97b60d9",
    "boa_parser-0.22.0": "641e81b3c8cbb7a2140547fb3ea534e9edf210b4e8c920b5fa864a919e11fbcf",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or ".." in path.parts or "\\" in value or ":" in value:
        raise ValueError(f"Unsafe relative path: {value}")
    return path


def read_archive(path, name, checksum):
    data = path.read_bytes()
    if sha(data) != checksum:
        raise ValueError(f"Archive checksum mismatch: {path}")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            item = relative_path(member.name)
            if item.parts[0] != name:
                raise ValueError("Unexpected crate root")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("Archive links and special entries are forbidden")
            key = PurePosixPath(*item.parts[1:]).as_posix()
            if key == "." or key in files:
                raise ValueError("Invalid or duplicate archive file")
            files[key] = archive.extractfile(member).read()
    if json.loads(files[".cargo_vcs_info.json"])["git"]["sha1"] != UPSTREAM:
        raise ValueError("Unexpected upstream Git revision")
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().with_name("manifest.json"))
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve(strict=True)
    manifest_bytes = manifest_path.read_bytes()
    if sha(manifest_bytes) != args.manifest_sha256.lower():
        raise ValueError("Manifest checksum mismatch")
    manifest = json.loads(manifest_bytes)
    if manifest["schema"] != "jovault-boa-default-class-name-experiment-v1" or manifest["upstream"] != UPSTREAM:
        raise ValueError("Unexpected manifest schema or upstream revision")
    if len(manifest["crates"]) != len(CRATES) or {c["name"] for c in manifest["crates"]} != set(CRATES):
        raise ValueError("Unexpected crate set")
    verified = []
    for crate in manifest["crates"]:
        name = crate["name"]
        if crate["archiveSha256"] != CRATES[name]:
            raise ValueError("Manifest changed archive trust anchor")
        original = read_archive(args.cache_dir / (name + ".crate"), name, CRATES[name])
        patch_path = manifest_path.with_name(name + ".patch").resolve(strict=True)
        if sha(patch_path.read_bytes()) != crate["patchSha256"]:
            raise ValueError("Patch checksum mismatch")
        expected = {path: sha(data) for path, data in original.items()}
        seen = set()
        for entry in crate["changedFiles"]:
            key = relative_path(entry["path"]).as_posix()
            if key in seen:
                raise ValueError("Duplicate changed-file entry")
            seen.add(key)
            if expected.get(key) != entry["beforeSha256"]:
                raise ValueError(f"Before hash mismatch: {name}/{key}")
            expected[key] = entry["afterSha256"]
        verified.append((name, original, patch_path, expected))
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    for name, original, patch_path, expected in verified:
        folder = destination / name
        folder.mkdir()
        for key, data in original.items():
            target = folder / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        command = ["git", "-c", "core.autocrlf=false", "apply", "--no-index", "-p2", "--whitespace=error-all"]
        subprocess.run(command + ["--check", str(patch_path)], cwd=folder, check=True)
        subprocess.run(command + [str(patch_path)], cwd=folder, check=True)
        actual = {p.relative_to(folder).as_posix(): sha(p.read_bytes()) for p in folder.rglob("*") if p.is_file()}
        if actual != expected:
            mismatches = [key for key in sorted(set(actual) | set(expected)) if actual.get(key) != expected.get(key)]
            raise ValueError(f"Post-patch tree mismatch: {name}: {mismatches}")
    receipt = {"manifestSha256": sha(manifest_bytes), "upstream": UPSTREAM, "destination": str(destination), "crates": [item[0] for item in verified], "rustExecuted": False}
    (destination / "patch-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
