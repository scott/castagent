import re
from typing import Optional


class PrivacyFilter:
    PATTERNS = [
        (r'(api[_-]?key|api key)\s*[:=]\s*\S{8,}', 'CREDENTIAL'),
        (r'(secret|token|password)\s*[:=]\s*\S{8,}', 'CREDENTIAL'),
        (r'secret["\s:=]+["\']?[^\s"\']{8,}["\']?', 'SECRET'),
        (r'token["\s:=]+["\']?[^\s"\']{8,}["\']?', 'TOKEN'),
        (r'password["\s:=]+["\']?[^\s"\']{8,}["\']?', 'PASSWORD'),
        (r'bearer\s+[\w-]{20,}', 'BEARER_TOKEN'),
        (r'ghp_[a-zA-Z0-9]{36}', 'GITHUB_TOKEN'),
        (r'ghs_[a-zA-Z0-9]{36}', 'GITHUB_TOKEN'),
        (r'gho_[a-zA-Z0-9]{36}', 'GITHUB_TOKEN'),
        (r'xox[baprs]-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{24,}', 'SLACK_TOKEN'),
        (r'AKIA[0-9A-Z]{16}', 'AWS_KEY'),
        (r'\d{3}-\d{2}-\d{4}', 'SSN'),
        (r'\d{16}', 'CARD_NUMBER'),
        (r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', 'EMAIL'),
    ]

    PLACEHOLDER = "[REDACTED]"

    def __init__(self):
        self._compiled = [(re.compile(pattern, re.IGNORECASE), replacement) 
                          for pattern, replacement in self.PATTERNS]

    def scrub(self, text: str, preserve_structure: bool = True) -> str:
        if not text:
            return text

        result = text
        for pattern, _ in self._compiled:
            result = pattern.sub(self.PLACEHOLDER, result)

        if preserve_structure:
            result = self._restore_structure(result)

        return result

    def _restore_structure(self, text: str) -> str:
        text = re.sub(r'\s+', ' ', text)
        text = re.sub(r'\[REDACTED\]\s*\[REDACTED\]', self.PLACEHOLDER, text)
        return text.strip()

    def scrub_dict(self, data: dict, keys_to_scrub: Optional[list[str]] = None) -> dict:
        if keys_to_scrub is None:
            keys_to_scrub = ['key', 'token', 'secret', 'password', 'credential', 'auth']

        result = {}
        for k, v in data.items():
            if any(protected in k.lower() for protected in keys_to_scrub):
                result[k] = self.PLACEHOLDER
            elif isinstance(v, str):
                result[k] = self.scrub(v)
            elif isinstance(v, dict):
                result[k] = self.scrub_dict(v, keys_to_scrub)
            else:
                result[k] = v
        return result

    def is_sensitive(self, text: str) -> bool:
        for pattern, _ in self._compiled:
            if pattern.search(text):
                return True
        return False