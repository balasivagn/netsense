import importlib
import sys


def test_package_import_has_no_vendor_side_effects() -> None:
    package = importlib.import_module("netsense_orch")
    assert package.__version__ == "0.1.0"
    assert sys.version_info[:2] == (3, 12)
    assert not any(name in sys.modules for name in ("modal", "clerk_backend_api"))
