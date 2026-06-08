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

        repo.index.add(repo.untracked_files)
        repo.index.add([item.a_path for item in repo.index.diff('HEAD')])

        commit = repo.index.commit(message)

        return f"Committed successfully!\nCommit: {commit.hexsha[:7]}\nMessage: {message}"

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
            repo.index.add(files)
            return f"Staged {len(files)} file(s)."
        else:
            repo.index.add(repo.untracked_files)
            repo.index.add([item.a_path for item in repo.index.diff('HEAD')])
            return "Staged all non-ignored files."

    except git.InvalidGitRepositoryError:
        return "Not a valid Git repository."
    except Exception as e:
        return f"Error staging files: {str(e)}"