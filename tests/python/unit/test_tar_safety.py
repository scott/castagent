"""Archives must not write outside the extract directory.

Issue 251: a symlink member whose target is an absolute directory, followed
by a regular member named through that link, escapes tarfile.extractall
when no data filter is applied. Undo, version restore, version diff, and
release extract all have to refuse that archive.
"""

import io
import stat
import tarfile
from pathlib import Path

import pytest
import yaml

from cast import releases
from cast import undo
from cast import versioning
from cast.tar_safety import UnsafeArchiveError, safe_extract


def _add_bytes(tar: tarfile.TarFile, name: str, payload: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(payload)
    info.mode = mode
    info.type = tarfile.REGTYPE
    tar.addfile(info, io.BytesIO(payload))


def _add_link(tar: tarfile.TarFile, name: str, linkname: str, kind: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = linkname
    tar.addfile(info)


def _escape_archive(path: Path, outside: Path) -> None:
    """Symlink to an absolute directory, then a file member through that link."""
    outside.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, "w:gz") as tar:
        _add_link(tar, "link", str(outside.resolve()), tarfile.SYMTYPE)
        _add_bytes(tar, "link/owned.txt", b"escaped\n")


def _benign_archive(path: Path) -> None:
    with tarfile.open(path, "w:gz") as tar:
        info = tarfile.TarInfo("mcp")
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        _add_bytes(tar, "agent.yaml", b"name: demo\n")
        _add_bytes(tar, "mcp/server.json", b"{}\n")


def _assert_contained(outside: Path, destination: Path) -> None:
    owned = outside / "owned.txt"
    assert not owned.exists()
    assert list(outside.iterdir()) == []
    assert not (destination / "link").is_symlink()


class TestSafeExtract:
    def test_absolute_symlink_does_not_escape(self, tmp_path):
        outside = tmp_path / "outside"
        archive = tmp_path / "escape.tar.gz"
        destination = tmp_path / "dest"
        _escape_archive(archive, outside)

        with tarfile.open(archive, "r:gz") as tar:
            member = tar.getmembers()[0]
            assert member.issym()
            assert Path(member.linkname).is_absolute()
            with pytest.raises(UnsafeArchiveError, match="link member"):
                safe_extract(tar, destination)

        _assert_contained(outside, destination)

    def test_parent_link_target_is_refused(self, tmp_path):
        archive = tmp_path / "parent.tar.gz"
        destination = tmp_path / "dest"
        with tarfile.open(archive, "w:gz") as tar:
            _add_link(tar, "link", "../../outside", tarfile.SYMTYPE)
            _add_bytes(tar, "link/owned.txt", b"escaped\n")

        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError):
                safe_extract(tar, destination)

        assert not (tmp_path / "owned.txt").exists()
        assert not (destination / "link").is_symlink()

    def test_relative_symlink_is_refused(self, tmp_path):
        archive = tmp_path / "relative.tar.gz"
        destination = tmp_path / "dest"
        with tarfile.open(archive, "w:gz") as tar:
            _add_link(tar, "link", "notes.md", tarfile.SYMTYPE)

        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError, match="link member"):
                safe_extract(tar, destination)

        assert not (destination / "link").exists()

    def test_hard_link_is_refused(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        archive = tmp_path / "hard.tar.gz"
        destination = tmp_path / "dest"
        with tarfile.open(archive, "w:gz") as tar:
            _add_link(tar, "link", str(outside.resolve() / "owned.txt"), tarfile.LNKTYPE)

        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError, match="link member"):
                safe_extract(tar, destination)

        assert not (outside / "owned.txt").exists()
        assert not (destination / "link").exists()

    def test_dotdot_member_name_is_refused(self, tmp_path):
        archive = tmp_path / "dotdot.tar.gz"
        destination = tmp_path / "dest"
        destination.mkdir()
        with tarfile.open(archive, "w:gz") as tar:
            _add_bytes(tar, "../owned.txt", b"escaped\n")

        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError, match="member name"):
                safe_extract(tar, destination)

        assert not (tmp_path / "owned.txt").exists()

    def test_special_file_is_refused(self, tmp_path):
        archive = tmp_path / "fifo.tar.gz"
        destination = tmp_path / "dest"
        with tarfile.open(archive, "w:gz") as tar:
            info = tarfile.TarInfo("mcp/fifo")
            info.type = tarfile.FIFOTYPE
            tar.addfile(info)

        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError, match="special member"):
                safe_extract(tar, destination)

        assert not (destination / "mcp" / "fifo").exists()

    def test_existing_symlink_is_not_followed(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        destination = tmp_path / "dest"
        destination.mkdir()
        (destination / "link").symlink_to(outside, target_is_directory=True)
        archive = tmp_path / "through.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            _add_bytes(tar, "link/owned.txt", b"escaped\n")

        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError, match="symlink"):
                safe_extract(tar, destination)

        assert not (outside / "owned.txt").exists()

    def test_benign_archive_extracts(self, tmp_path):
        archive = tmp_path / "ok.tar.gz"
        destination = tmp_path / "dest"
        _benign_archive(archive)

        with tarfile.open(archive, "r:gz") as tar:
            safe_extract(tar, destination)

        assert (destination / "agent.yaml").read_text() == "name: demo\n"
        assert (destination / "mcp" / "server.json").read_text() == "{}\n"

    def test_extract_passes_data_filter(self, tmp_path, monkeypatch):
        archive = tmp_path / "ok.tar.gz"
        destination = tmp_path / "dest"
        _benign_archive(archive)
        seen = {}
        original = tarfile.TarFile.extractall

        def wrapped(self, path=".", members=None, *, numeric_owner=False, filter=None):
            seen["filter"] = filter
            return original(self, path, members, numeric_owner=numeric_owner, filter=filter)

        monkeypatch.setattr(tarfile.TarFile, "extractall", wrapped)
        with tarfile.open(archive, "r:gz") as tar:
            safe_extract(tar, destination)

        assert seen["filter"] == "data"
        assert (destination / "agent.yaml").read_text() == "name: demo\n"

    def test_filter_type_error_is_not_retried(self, tmp_path, monkeypatch):
        archive = tmp_path / "ok.tar.gz"
        destination = tmp_path / "dest"
        _benign_archive(archive)

        def wrapped(self, path=".", members=None, *, numeric_owner=False, filter=None):
            if filter is None:
                raise AssertionError("unfiltered extractall")
            raise TypeError("filter is not supported")

        monkeypatch.setattr(tarfile.TarFile, "extractall", wrapped)
        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(TypeError, match="not supported"):
                safe_extract(tar, destination)

        assert not (destination / "agent.yaml").exists()

    def test_without_data_filter_still_refuses_escape(self, tmp_path, monkeypatch):
        outside = tmp_path / "outside"
        archive = tmp_path / "escape.tar.gz"
        destination = tmp_path / "dest"
        _escape_archive(archive, outside)
        monkeypatch.setattr("cast.tar_safety.data_filter_supported", lambda: False)

        def wrapped(*_args, **_kwargs):
            raise AssertionError("extractall must not run without a data filter")

        monkeypatch.setattr(tarfile.TarFile, "extractall", wrapped)
        with tarfile.open(archive, "r:gz") as tar:
            with pytest.raises(UnsafeArchiveError):
                safe_extract(tar, destination)

        _assert_contained(outside, destination)

    def test_without_data_filter_extracts_files_and_strips_setuid(self, tmp_path, monkeypatch):
        archive = tmp_path / "mode.tar.gz"
        destination = tmp_path / "dest"
        monkeypatch.setattr("cast.tar_safety.data_filter_supported", lambda: False)
        monkeypatch.setattr(
            tarfile.TarFile,
            "extractall",
            lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("extractall")),
        )
        with tarfile.open(archive, "w:gz") as tar:
            _add_bytes(tar, "tools/run.sh", b"#!/bin/sh\n", mode=0o755)
            _add_bytes(tar, "tools/setuid.sh", b"#!/bin/sh\n", mode=0o4644)

        with tarfile.open(archive, "r:gz") as tar:
            safe_extract(tar, destination)

        run_mode = stat.S_IMODE((destination / "tools" / "run.sh").stat().st_mode)
        setuid_mode = stat.S_IMODE((destination / "tools" / "setuid.sh").stat().st_mode)
        assert run_mode & 0o111
        assert setuid_mode & 0o4000 == 0
        assert (destination / "tools" / "run.sh").read_bytes() == b"#!/bin/sh\n"


def _agent_yaml(agent_path: Path, name: str) -> None:
    agent_path.mkdir(parents=True, exist_ok=True)
    (agent_path / "mcp").mkdir(exist_ok=True)
    (agent_path / "tools").mkdir(exist_ok=True)
    config = {
        "name": name,
        "version": "0.0",
        "description": "tar safety fixture",
        "brain": {"model": "test-model", "instructions_file": "instructions.md"},
        "tools": {"builtin": ["bash"], "mcp": [], "custom": []},
    }
    with open(agent_path / "agent.yaml", "w") as handle:
        yaml.dump(config, handle)
    (agent_path / "instructions.md").write_text("# Initial\n")


def _patch_agents(monkeypatch, agents: Path) -> None:
    monkeypatch.setattr(versioning, "AGENTS_DIR", agents)
    monkeypatch.setattr(undo, "AGENTS_DIR", agents)
    monkeypatch.setattr(releases, "AGENTS_DIR", agents)


class TestSnapshotCallSites:
    def test_create_version_omits_symlink_and_does_not_pack_target(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("not-for-archive\n")
        (agent / "mcp" / "link").symlink_to(outside, target_is_directory=True)
        (agent / "mcp" / "real.json").write_text("{}\n")

        versioning.create_version("boxed", source="create", message="initial")

        archive = agent / ".cast" / "changes" / "001.tar.gz"
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
        assert all(not member.issym() and not member.islnk() for member in members)
        names = [member.name for member in members]
        assert any(name.endswith("real.json") for name in names)
        assert not any("secret.txt" in name for name in names)
        assert not (outside / "owned.txt").exists()

    def test_undo_refuses_absolute_symlink_archive(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        versioning.create_version("boxed", source="create", message="v1")
        (agent / "instructions.md").write_text("# v2\n")
        versioning.create_version("boxed", source="builder", message="v2")

        outside = tmp_path / "outside"
        _escape_archive(agent / ".cast" / "changes" / "001.tar.gz", outside)

        with pytest.raises(UnsafeArchiveError):
            undo.undo("boxed")

        _assert_contained(outside, agent)
        assert (agent / "instructions.md").read_text() == "# v2\n"

    def test_revert_refuses_absolute_symlink_archive(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        versioning.create_version("boxed", source="create", message="v1")
        outside = tmp_path / "outside"
        _escape_archive(agent / ".cast" / "changes" / "001.tar.gz", outside)

        with pytest.raises(UnsafeArchiveError):
            versioning.revert_to_version("boxed", version_id=1)

        _assert_contained(outside, agent)
        assert (agent / "instructions.md").read_text() == "# Initial\n"

    def test_diff_refuses_absolute_symlink_archive(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        versions = agent / ".cast" / "versions"
        versions.mkdir(parents=True)
        outside = tmp_path / "outside"
        _escape_archive(versions / "001.tar.gz", outside)
        _benign_archive(versions / "002.tar.gz")

        with pytest.raises(UnsafeArchiveError):
            versioning.diff_versions("boxed", 1, 2)

        _assert_contained(outside, agent)

    def test_diff_still_reads_benign_archives(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        versions = agent / ".cast" / "versions"
        versions.mkdir(parents=True)
        with tarfile.open(versions / "001.tar.gz", "w:gz") as tar:
            _add_bytes(tar, "instructions.md", b"# one\n")
        with tarfile.open(versions / "002.tar.gz", "w:gz") as tar:
            _add_bytes(tar, "instructions.md", b"# two\n")

        result = versioning.diff_versions("boxed", 1, 2)

        assert result["instructions.md"]["changed"] is True
        assert result["instructions.md"]["v1_content"] == "# one\n"
        assert result["instructions.md"]["v2_content"] == "# two\n"

    def test_release_extract_refuses_absolute_symlink_archive(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        (agent / "keep.txt").write_text("keep\n")
        releases.create_release("boxed", "1.0", "initial")
        outside = tmp_path / "outside"
        tarball = agent / ".cast" / "releases" / "1.0.tar.gz"
        _escape_archive(tarball, outside)

        with pytest.raises(UnsafeArchiveError):
            releases.extract_release("boxed", "1.0", agent)

        _assert_contained(outside, agent)
        assert (agent / "keep.txt").read_text() == "keep\n"
        assert (agent / "instructions.md").read_text() == "# Initial\n"

    def test_create_release_omits_symlink(self, tmp_path, monkeypatch):
        agents = tmp_path / ".cast" / "agents"
        _patch_agents(monkeypatch, agents)
        agent = agents / "boxed"
        _agent_yaml(agent, "boxed")
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("not-for-archive\n")
        (agent / "mcp" / "link").symlink_to(outside, target_is_directory=True)
        (agent / "notes.md").write_text("notes\n")

        releases.create_release("boxed", "1.0", "initial")
        archive = agent / ".cast" / "releases" / "1.0.tar.gz"
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
        assert all(not member.issym() and not member.islnk() for member in members)
        names = [member.name for member in members]
        assert "notes.md" in names
        assert not any("secret.txt" in name for name in names)

        destination = tmp_path / "restored"
        destination.mkdir()
        releases.extract_release("boxed", "1.0", destination)
        assert (destination / "notes.md").read_text() == "notes\n"
        assert not (destination / "mcp" / "link").exists()
        assert not (outside / "owned.txt").exists()
