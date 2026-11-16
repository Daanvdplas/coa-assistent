"""Keep local eval configuration from changing isolated provider tests."""
import os
from unittest.mock import patch


def isolate_runtime_environment(test):
    system = {key: value for key, value in os.environ.items()
              if not key.startswith(('COA_', 'OPENAI_', 'ORQ_')) and key != 'CODEX_HOME'}
    environment = patch.dict(os.environ, system, clear=True)
    environment.start()
    test.addCleanup(environment.stop)
