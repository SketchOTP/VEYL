"""Fixed isolated Python 3.12 archive worker. No shell, exec, links, or extractall."""
import json
import os
import re
import resource
import stat
import sys
import tarfile
import zipfile

CHUNK = 1024 * 1024


def stamp(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino), "mode": str(info.st_mode),
            "size": str(info.st_size), "mtimeNs": str(info.st_mtime_ns), "ctimeNs": str(info.st_ctime_ns)}


def unchanged(file, expected):
    if stamp(os.lstat(file)) != expected:
        raise ValueError("Source changed during the archive operation: " + file)


def member_name(value):
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise ValueError("Unsafe archive member name")
    while value.startswith("./"):
        value = value[2:]
    value = value.rstrip("/")
    parts = value.split("/")
    if not value or any(part in ("", ".", "..") for part in parts):
        raise ValueError("Archive traversal or empty member name")
    if any(len(os.fsencode(part)) > 255 for part in parts) or len(value) > 4096:
        raise ValueError("Archive member path exceeds supported length")
    return value


def emit(**data):
    print(json.dumps(data, ensure_ascii=True), flush=True)


def validate_members(members, limits, compressed_size):
    seen, total = {}, 0
    filesystem_names = set()
    for item in members:
        item["name"] = member_name(item["name"])
        file = item["name"]
        if file in seen:
            raise ValueError("Duplicate archive member: " + file)
        seen[file] = item["directory"]
        if item["directory"] and item["size"] != 0:
            raise ValueError("Directory archive members must have zero size")
        filesystem_names.add(file)
        parent = os.path.dirname(file)
        while parent:
            filesystem_names.add(parent)
            parent = os.path.dirname(parent)
        total += item["size"]
        if len(filesystem_names) > limits["entries"] or total > limits["bytes"]:
            raise ValueError("Archive entry/uncompressed-byte limit exceeded")
        if item.get("compressed") is not None and item["size"] > 1024 * 1024 and item["size"] / max(1, item["compressed"]) > limits["ratio"]:
            raise ValueError("Archive compression-ratio limit exceeded")
    for file, directory in seen.items():
        parent = os.path.dirname(file)
        while parent:
            if parent in seen and not seen[parent]:
                raise ValueError("Archive file/directory name conflict: " + parent)
            parent = os.path.dirname(parent)
    if total > 1024 * 1024 and total / max(1, compressed_size) > limits["ratio"]:
        raise ValueError("Archive total compression-ratio limit exceeded")
    return total


def stream_copy(source, target, expected, budget):
    written = 0
    while True:
        block = source.read(min(CHUNK, expected - written + 1))
        if not block:
            break
        written += len(block)
        budget[0] += len(block)
        if written > expected or budget[0] > budget[1]:
            raise ValueError("Archive stream exceeded declared size/byte limit")
        target.write(block)
    if written != expected:
        raise ValueError("Archive stream size mismatch")
    return written


def manifest(destination):
    result = []
    stack = [destination]
    while stack:
        file = stack.pop()
        info = os.lstat(file)
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError("Destination changed into an unsupported entry")
        result.append({"path": file, "directory": stat.S_ISDIR(info.st_mode), "stamp": stamp(info)})
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(file) as children:
                stack.extend(child.path for child in children)
    # Reverse-depth removal in Node must see ancestors before descendants.
    result.sort(key=lambda entry: entry["path"].count(os.sep))
    return result


def sources(request):
    found, names, total = [], set(), 0
    limits = request["limits"]
    for root in request["sources"]:
        unchanged(root["path"], root["stamp"])
        stack = [(root["path"], os.path.basename(root["path"]))]
        while stack:
            file, relative = stack.pop()
            relative = member_name(relative)
            if relative in names:
                raise ValueError("Archive source names conflict: " + relative)
            names.add(relative)
            info = os.lstat(file)
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError("Archive creation excludes links, sockets, devices and special files")
            total += info.st_size if stat.S_ISREG(info.st_mode) else 0
            if len(names) > limits["entries"] or total > limits["bytes"]:
                raise ValueError("Archive source entry/byte limit exceeded")
            found.append({"path": file, "name": relative, "info": info, "stamp": stamp(info)})
            if stat.S_ISDIR(info.st_mode):
                with os.scandir(file) as children:
                    stack.extend((child.path, relative + "/" + child.name) for child in children)
    for item in found:
        unchanged(item["path"], item["stamp"])
    return found, total


def create(request):
    entries, total = sources(request)
    destination, archive_format = request["destination"], request["format"]
    if archive_format not in ("zip", "tar", "tar.gz"):
        raise ValueError("Unsupported archive format")
    # Exclusive no-follow output, only after complete source preflight.
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        if archive_format == "zip":
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                budget = [0, request["limits"]["bytes"]]
                for index, item in enumerate(entries):
                    unchanged(item["path"], item["stamp"])
                    info = item["info"]
                    entry = zipfile.ZipInfo(item["name"] + ("/" if stat.S_ISDIR(info.st_mode) else ""))
                    entry.external_attr = (info.st_mode & 0xFFFF) << 16
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    if stat.S_ISDIR(info.st_mode):
                        archive.writestr(entry, b"")
                    else:
                        descriptor = os.open(item["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        with os.fdopen(descriptor, "rb") as source:
                            if stamp(os.fstat(source.fileno())) != item["stamp"]:
                                raise ValueError("Source identity changed before reading")
                            with archive.open(entry, "w", force_zip64=True) as target:
                                stream_copy(source, target, info.st_size, budget)
                    unchanged(item["path"], item["stamp"])
                    if index % 250 == 0:
                        emit(type="progress", stage="archiving", entries=index + 1, total=len(entries))
        else:
            with tarfile.open(fileobj=output, mode="w:gz" if archive_format == "tar.gz" else "w") as archive:
                for index, item in enumerate(entries):
                    unchanged(item["path"], item["stamp"])
                    info = item["info"]
                    entry = tarfile.TarInfo(item["name"])
                    entry.mode = info.st_mode & 0o777
                    entry.mtime = int(info.st_mtime)
                    entry.type = tarfile.DIRTYPE if stat.S_ISDIR(info.st_mode) else tarfile.REGTYPE
                    entry.size = info.st_size if stat.S_ISREG(info.st_mode) else 0
                    if entry.isdir():
                        archive.addfile(entry)
                    else:
                        descriptor = os.open(item["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        with os.fdopen(descriptor, "rb") as source:
                            if stamp(os.fstat(source.fileno())) != item["stamp"]:
                                raise ValueError("Source identity changed before reading")
                            archive.addfile(entry, source)
                    unchanged(item["path"], item["stamp"])
                    if index % 250 == 0:
                        emit(type="progress", stage="archiving", entries=index + 1, total=len(entries))
        output.flush()
        os.fsync(output.fileno())
    for item in entries:
        unchanged(item["path"], item["stamp"])
    return {"entries": len(entries), "bytes": total}


def extract(request):
    source_path = request["sources"][0]["path"]
    expected = request["sources"][0]["stamp"]
    unchanged(source_path, expected)
    descriptor = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        if stamp(os.fstat(source.fileno())) != expected or not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Archive source changed or is not a regular file")
        members = []
        if zipfile.is_zipfile(source):
            source.seek(0)
            archive = zipfile.ZipFile(source, "r")
            for entry in archive.infolist():
                unix_mode = entry.external_attr >> 16
                unix_type = stat.S_IFMT(unix_mode)
                if entry.flag_bits & 1 or unix_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ValueError("Encrypted/link/special ZIP members are unsupported")
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError("Unsupported ZIP compression method")
                members.append({"name": entry.filename, "directory": entry.is_dir(), "size": entry.file_size, "compressed": entry.compress_size, "mode": unix_mode & 0o777, "entry": entry})
        else:
            source.seek(0)
            archive = tarfile.open(fileobj=source, mode="r:*")
            for entry in archive:
                if not (entry.isdir() or entry.isreg()) or entry.sparse is not None or entry.type == tarfile.GNUTYPE_SPARSE:
                    raise ValueError("TAR links/sparse/special members are unsupported")
                members.append({"name": entry.name, "directory": entry.isdir(), "size": entry.size, "mode": entry.mode & 0o777, "entry": entry})
                if len(members) > request["limits"]["entries"]:
                    raise ValueError("Archive entry limit exceeded")
        with archive:
            total = validate_members(members, request["limits"], os.fstat(source.fileno()).st_size)
            if request.get("agent"):
                # Generic hidden ancestors/directories; ordinary hidden files remain usable.
                sensitive = re.compile(r"(?:^|/)\.[^/]+/|(?:^|/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$", re.I)
                hidden_directory = re.compile(r"(?:^|/)\.[^/]+$", re.I)
                if any(sensitive.search(item["name"]) or item["directory"] and hidden_directory.search(item["name"]) for item in members):
                    raise ValueError("Agent extraction excludes credential/configuration entries; manual explorer controls remain available")
            unchanged(source_path, expected)
            os.mkdir(request["destination"], 0o700)
            budget = [0, request["limits"]["bytes"]]
            # Explicit directory creation precedes files. No archive-supplied links can become parents.
            directories = set()
            for item in members:
                directory = item["name"] if item["directory"] else os.path.dirname(item["name"])
                while directory:
                    directories.add(directory)
                    directory = os.path.dirname(directory)
            for directory in sorted(directories, key=lambda value: value.count("/")):
                os.mkdir(os.path.join(request["destination"], directory), 0o755)
            for index, item in enumerate(members):
                if not item["directory"]:
                    target_path = os.path.join(request["destination"], item["name"])
                    target_descriptor = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, item["mode"] or 0o644)
                    with os.fdopen(target_descriptor, "wb") as target:
                        stream = archive.open(item["entry"], "r") if isinstance(archive, zipfile.ZipFile) else archive.extractfile(item["entry"])
                        if stream is None:
                            raise ValueError("Archive member has no readable stream")
                        with stream:
                            stream_copy(stream, target, item["size"], budget)
                        target.flush()
                        os.fsync(target.fileno())
                if index % 250 == 0:
                    emit(type="progress", stage="extracting", entries=index + 1, total=len(members))
            if stamp(os.fstat(source.fileno())) != expected:
                raise ValueError("Archive changed while extracting; partial destination retained")
            unchanged(source_path, expected)
    return {"entries": len(members), "bytes": total}


def main():
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 130))
    request = json.loads(sys.stdin.buffer.read(256 * 1024 + 1))
    if sys.version_info < (3, 12):
        raise RuntimeError("Archive operations require Python 3.12 or newer")
    result = create(request) if request["action"] == "archive-create" else extract(request) if request["action"] == "archive-extract" else None
    if result is None:
        raise ValueError("Unsupported archive action")
    with open(request["manifest"], "x", encoding="utf-8") as output:
        json.dump(manifest(request["destination"]), output)
    emit(type="result", ok=True, **result)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(type="result", ok=False, message=str(error) or type(error).__name__)
        sys.exit(1)
