import os
import yaml
from typing import Optional, List
from langchain_core.tools import tool
import git


def get_agent_path() -> str:
    agent_dir = os.environ.get('CAST_AGENT_DIR')
    if agent_dir:
        return agent_dir

    home = os.path.expanduser('~')
    return os.path.join(home, '.cast', 'agents')


# Persistent notes can hold credentials. Never stage this path.
PRIVATE_NOTE_PATH = "memory/notes.md"


def _normalize_repo_path(path: str) -> str:
    normalized = path.replace("\\", "/").strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _is_private_note(path: str) -> bool:
    return _normalize_repo_path(path) == PRIVATE_NOTE_PATH


def _public_paths(paths: List[str]) -> List[str]:
    return [path for path in paths if path and not _is_private_note(path)]


def _staged_paths(repo) -> List[str]:
    paths = []
    for item in repo.index.diff("HEAD"):
        path = getattr(item, "a_path", None) or getattr(item, "b_path", None)
        if path:
            paths.append(path)
    return paths


def _index_has_private_note(repo) -> bool:
    try:
        listed = repo.git.ls_files("--", PRIVATE_NOTE_PATH)
    except Exception:
        return False
    if not isinstance(listed, str):
        return False
    return any(_is_private_note(line.strip()) for line in listed.splitlines() if line.strip())


def _head_has_private_note(repo) -> bool:
    try:
        repo.git.cat_file("-e", f"HEAD:{PRIVATE_NOTE_PATH}")
    except Exception:
        return False
    return True


def _stage_public_changes(repo) -> tuple[bool, bool]:
    """Stage public changes and keep memory/notes.md out of the index.

    A tracked notes file is removed from the index and left on disk.
    Returns (skipped_private_note, have_changes_to_commit).
    """
    in_index = _index_has_private_note(repo)
    in_head = _head_has_private_note(repo) if in_index else False
    if in_index:
        repo.git.rm("--cached", "--ignore-unmatch", "--", PRIVATE_NOTE_PATH)
    untracked = [path for path in (repo.untracked_files or []) if path]
    skipped = in_index or any(_is_private_note(path) for path in untracked)
    public_untracked = _public_paths(untracked)
    public_staged = _public_paths(_staged_paths(repo))
    if public_untracked:
        repo.index.add(public_untracked)
    if public_staged:
        repo.index.add(public_staged)
    removal = in_index and in_head
    return skipped, bool(public_untracked or public_staged or removal)


def load_agent_config(agent_path: str) -> dict:
    config_path = os.path.join(agent_path, 'agent.yaml')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                return yaml.safe_load(f) or {}
        except yaml.YAMLError:
            return {}
    return {}


@tool
def git_status() -> str:
    """
    Get the Git status of the current agent repository.

    Returns a summary of the working tree status including:
    - Current branch
    - Modified files
    - Untracked files
    - Staged files
    - Number of commits ahead/behind remote
    """
    agent_path = get_agent_path()
    git_dir = os.path.join(agent_path, '.git')

    if not os.path.exists(git_dir):
        return "Not a Git repository. Initialize with 'cast git init <agent>'"

    try:
        repo = git.Repo(agent_path)
        status = repo.git.status()

        branches = repo.branches
        current_branch = repo.active_branch.name if repo.head.is_detached else 'main'

        staged = [item.a_path for item in repo.index.diff('HEAD')]
        unstaged = [item.a_path for item in repo.index.diff(None)]
        untracked = repo.untracked_files

        ahead = 0
        behind = 0
        if 'origin' in repo.remotes:
            remote = repo.remotes.origin
            tracking_branch = repo.active_branch.tracking_branch()
            if tracking_branch:
                ahead = repo.iter_commits(f'{tracking_branch}..{repo.active_branch}')
                behind = repo.iter_commits(f'{repo.active_branch}..{tracking_branch}')
                ahead = sum(1 for _ in ahead)
                behind = sum(1 for _ in behind)

        result = f"Current branch: {current_branch}\n\n"

        if staged:
            result += f"Staged files ({len(staged)}):\n"
            for f in staged:
                result += f"  + {f}\n"
            result += "\n"

        if unstaged:
            result += f"Modified files ({len(unstaged)}):\n"
            for f in unstaged:
                result += f"  M {f}\n"
            result += "\n"

        if untracked:
            result += f"Untracked files ({len(untracked)}):\n"
            for f in untracked:
                result += f"  ?? {f}\n"
            result += "\n"

        if ahead > 0 or behind > 0:
            result += f"Sync status: {ahead} ahead, {behind} behind\n\n"

        if not staged and not unstaged and not untracked:
            result += "Working tree is clean."

        return result

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except Exception as e:
        return f"Error getting status: {str(e)}"


@tool
def git_commit(message: str) -> str:
    """
    Stage all non-ignored files and commit with the given message.

    memory/notes.md is private and is never staged. A copy already in
    the index is removed from the commit and left on disk.

    Args:
        message: The commit message
    """
    agent_path = get_agent_path()
    git_dir = os.path.join(agent_path, '.git')

    if not os.path.exists(git_dir):
        return "Not a Git repository. Initialize with 'cast git init <agent>'"

    try:
        repo = git.Repo(agent_path)

        config = load_agent_config(agent_path)

        readme_path = os.path.join(agent_path, 'README.md')
        if os.path.exists(readme_path):
            pass

        skipped_notes, staged_public = _stage_public_changes(repo)
        if skipped_notes and not staged_public:
            return "Nothing to commit. memory/notes.md is private and was not staged."

        commit = repo.index.commit(message)

        result = f"Committed successfully!\nCommit: {commit.hexsha[:7]}\nMessage: {message}"
        if skipped_notes:
            result += "\nmemory/notes.md is private and was not staged."
        return result

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except Exception as e:
        return f"Error committing: {str(e)}"


@tool
def git_push(remote: str = "origin", branch: Optional[str] = None) -> str:
    """
    Push commits to the remote repository.

    Args:
        remote: The remote name (default: origin)
        branch: The branch name (default: current branch)
    """
    agent_path = get_agent_path()
    git_dir = os.path.join(agent_path, '.git')

    if not os.path.exists(git_dir):
        return "Not a Git repository. Initialize with 'cast git init <agent>'"

    try:
        repo = git.Repo(agent_path)

        if not branch:
            if repo.head.is_detached:
                branch = 'main'
            else:
                branch = repo.active_branch.name

        if remote not in [r.name for r in repo.remotes]:
            return f"Remote '{remote}' not found. Add it with 'cast git remote <agent> add {remote} <url>'"

        origin = repo.remotes[remote]
        info = origin.push(branch)

        pushed = len(info) > 0 and info[0].flags > 0
        if pushed:
            return f"Pushed to {remote}/{branch} successfully!"
        else:
            return f"Everything up-to-date at {remote}/{branch}"

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except git.GitCommandError as e:
        if 'AuthenticationFailed' in str(e) or 'Permission denied' in str(e):
            return "Authentication failed. Check your credentials or SSH keys."
        return f"Push failed: {str(e)}"
    except Exception as e:
        return f"Error pushing: {str(e)}"


@tool
def git_log(n: int = 10) -> str:
    """
    Get the recent commit history.

    Args:
        n: Number of commits to show (default: 10)
    """
    agent_path = get_agent_path()
    git_dir = os.path.join(agent_path, '.git')

    if not os.path.exists(git_dir):
        return "Not a Git repository. Initialize with 'cast git init <agent>'"

    try:
        repo = git.Repo(agent_path)

        commits = list(repo.iter_commits(max_count=n))

        if not commits:
            return "No commits yet."

        result = f"Recent commits (last {len(commits)}):\n\n"

        for commit in commits:
            result += f"commit {commit.hexsha[:7]}\n"
            result += f"Author: {commit.author.name} <{commit.author.email}>\n"
            result += f"Date: {commit.committed_datetime.strftime('%Y-%m-%d %H:%M:%S')}\n"
            result += f"\n    {commit.message.strip()}\n\n"

        return result

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except Exception as e:
        return f"Error getting log: {str(e)}"


@tool
def git_diff(file: Optional[str] = None) -> str:
    """
    Show unstaged changes or diff for a specific file.

    Args:
        file: Optional specific file to diff
    """
    agent_path = get_agent_path()
    git_dir = os.path.join(agent_path, '.git')

    if not os.path.exists(git_dir):
        return "Not a Git repository. Initialize with 'cast git init <agent>'"

    try:
        repo = git.Repo(agent_path)

        if file:
            diff = repo.git.diff(f'HEAD', '--', file)
        else:
            diff = repo.git.diff()

        if not diff:
            return "No changes to show."

        return diff

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except Exception as e:
        return f"Error getting diff: {str(e)}"


@tool
def git_add(files: Optional[List[str]] = None) -> str:
    """
    Stage specific files for commit.

    memory/notes.md is private and is never staged.

    Args:
        files: List of file paths to stage. If None, stages all non-ignored files.
    """
    agent_path = get_agent_path()
    git_dir = os.path.join(agent_path, '.git')

    if not os.path.exists(git_dir):
        return "Not a Git repository. Initialize with 'cast git init <agent>'"

    try:
        repo = git.Repo(agent_path)

        if files:
            public = _public_paths(list(files))
            skipped_notes = any(_is_private_note(path) for path in files)
            if public:
                repo.index.add(public)
            if skipped_notes and not public:
                return "Skipped memory/notes.md. That file is private and was not staged."
            if skipped_notes:
                return f"Staged {len(public)} file(s). Skipped private memory/notes.md."
            return f"Staged {len(public)} file(s)."
        else:
            skipped_notes, _staged_public = _stage_public_changes(repo)
            if skipped_notes:
                return "Staged all non-ignored files. Skipped private memory/notes.md."
            return "Staged all non-ignored files."

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except Exception as e:
        return f"Error staging files: {str(e)}"