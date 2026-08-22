"""tabtin-filegen CLI — generate office/pdf files from JSON specs.

Commands:
  create       generate a file from a spec
  list-types   list supported file types
  schema       print the JSON spec for a file type

The Go ``tabtin file create`` proxy invokes ``create`` with the spec piped on
stdin. The CLI also works standalone for humans and tests.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from typing import Any, Dict

# Importing the generators package registers every supported file type.
import tabtin_filegen.generators  # noqa: F401
from tabtin_filegen.errors import FileGenError, SpecError
from tabtin_filegen.registry import (
    get_by_extension,
    get_generator,
    get_reader,
    get_reader_by_extension,
    list_generators,
    list_readers,
)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help()
        return 2
    try:
        return handler(args)
    except FileGenError as err:
        _emit_error(err.code, str(err))
        return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tabtin-filegen", description=__doc__)
    sub = parser.add_subparsers(dest="command")

    create = sub.add_parser("create", help="generate a file from a JSON spec")
    create.add_argument("-t", "--type", dest="file_type", help="file type, e.g. xlsx")
    create.add_argument("-o", "--output", required=True, help="output file path")
    create.add_argument(
        "-s",
        "--spec",
        default="-",
        help="JSON spec: '-' for stdin, '@path' for a file, or literal JSON",
    )
    create.set_defaults(handler=_cmd_create)

    read = sub.add_parser("read", help="extract content from an existing file")
    read.add_argument("-t", "--type", dest="file_type", help="file type, e.g. xlsx")
    read.add_argument("-i", "--input", required=True, help="input file path")
    read.set_defaults(handler=_cmd_read)

    list_types = sub.add_parser("list-types", help="list supported file types")
    list_types.set_defaults(handler=_cmd_list_types)

    schema = sub.add_parser("schema", help="print the JSON spec for a file type")
    schema.add_argument("-t", "--type", dest="file_type", required=True)
    schema.set_defaults(handler=_cmd_schema)

    return parser


def _cmd_create(args: argparse.Namespace) -> int:
    file_type = _resolve_file_type(args.file_type, args.output)
    generator = get_generator(file_type)
    spec = _load_spec(args.spec)

    output_path = os.path.abspath(args.output)
    parent = os.path.dirname(output_path) or "."
    os.makedirs(parent, exist_ok=True)

    # Atomic write: generate to a temp file in the same directory, then replace.
    fd, tmp_path = tempfile.mkstemp(prefix=".tabtin-filegen-", dir=parent)
    os.close(fd)
    try:
        generator.generate(spec, tmp_path)
        os.replace(tmp_path, output_path)
    except Exception:
        _silent_remove(tmp_path)
        raise

    result = {
        "path": output_path,
        "file_type": generator.file_type,
        "file_size": os.path.getsize(output_path),
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def _cmd_read(args: argparse.Namespace) -> int:
    file_type = _resolve_read_type(args.file_type, args.input)
    reader = get_reader(file_type)
    input_path = os.path.abspath(args.input)
    if not os.path.isfile(input_path):
        raise SpecError(f"input file not found: {args.input}")

    content = reader.read(input_path)
    json.dump(content, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def _cmd_list_types(_args: argparse.Namespace) -> int:
    generators = {gen.file_type: list(gen.extensions) for gen in list_generators()}
    readers = {rd.file_type for rd in list_readers()}
    payload = [
        {
            "file_type": file_type,
            "extensions": extensions,
            "can_generate": True,
            "can_read": file_type in readers,
        }
        for file_type, extensions in generators.items()
    ]
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def _cmd_schema(args: argparse.Namespace) -> int:
    generator = get_generator(args.file_type)
    sys.stdout.write(generator.spec_help())
    sys.stdout.write("\n")
    return 0


def _resolve_file_type(file_type: str | None, output: str) -> str:
    if file_type:
        return file_type.lower()
    ext = os.path.splitext(output)[1].lower()
    generator = get_by_extension(ext) if ext else None
    if generator is None:
        raise SpecError(
            "cannot infer file type from output extension; pass --type explicitly"
        )
    return generator.file_type


def _resolve_read_type(file_type: str | None, input_path: str) -> str:
    if file_type:
        return file_type.lower()
    ext = os.path.splitext(input_path)[1].lower()
    reader = get_reader_by_extension(ext) if ext else None
    if reader is None:
        raise SpecError(
            "cannot infer file type from input extension; pass --type explicitly"
        )
    return reader.file_type


def _load_spec(spec_arg: str) -> Dict[str, Any]:
    if spec_arg == "-":
        raw = sys.stdin.read()
    elif spec_arg.startswith("@"):
        path = spec_arg[1:]
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError as err:
            raise SpecError(f"cannot read spec file: {err.strerror or 'unreadable'}")
    else:
        raw = spec_arg

    if not raw.strip():
        raise SpecError("spec is empty")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        raise SpecError(f"spec is not valid JSON: {err.msg} (line {err.lineno})")
    if not isinstance(parsed, dict):
        raise SpecError("spec must be a JSON object")
    return parsed


def _emit_error(code: str, message: str) -> None:
    json.dump({"error": {"code": code, "message": message}}, sys.stderr, ensure_ascii=False)
    sys.stderr.write("\n")


def _silent_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
