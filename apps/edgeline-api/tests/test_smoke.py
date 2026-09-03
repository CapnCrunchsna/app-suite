"""Toolchain smoke test.

Proves the uv-managed environment builds and imports the package, and that the
`es` marker wired up in conftest.py actually gates on datastore reachability.
Real coverage starts with the golden tests from spec §14.
"""

from __future__ import annotations

import pytest

from edgeline import __version__


def test_package_imports():
    assert __version__ == "0.1.0"


@pytest.mark.es
def test_es_marker_is_wired():
    """Skipped by conftest while nothing answers on ES_URL; a no-op when one does.

    Deliberately trivial: its job is to prove the skip path, not the datastore.
    """
    assert True
