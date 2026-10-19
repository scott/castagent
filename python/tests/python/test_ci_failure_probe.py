def test_deliberate_ci_failure():
    """Temporary probe. Reverted after CI shows the Python step can go red."""
    assert False, "deliberate CI failure"
