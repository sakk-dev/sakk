# Publishing sakk-litellm to PyPI (by hand)

> **Who and when.** Publishing is the owner's action, done once by hand on
> launch day, after github.com/sakk-dev/sakk is public: the package's links
> point there. This repository has no publishing workflow; nothing here runs
> in CI. Cost: free (PyPI charges nothing), about 15 minutes.

The package is `integrations/litellm/pyproject.toml`: the module
`sakk_gateway.py` alone, Apache-2.0 with the repository's LICENSE and NOTICE,
version equal to `package.json` (`test/gateway-package.test.mjs` checks the
metadata).

## 1. Build and inspect

From the repository root, on the commit being released:

```bash
out=$(mktemp -d)
uv build --out-dir "$out" integrations/litellm
unzip -l "$out"/sakk_litellm-*-py3-none-any.whl
tar -tzf "$out"/sakk_litellm-*.tar.gz
uvx twine check "$out"/*
```

`uv build` fetches the build backend (hatchling) into a throwaway
environment; it does not install LiteLLM. Add `--offline` to use only uv's
cache. The wheel must hold `sakk_gateway.py` and the `sakk_litellm-<version>.dist-info`
folder only (METADATA, WHEEL, RECORD, and LICENSE and NOTICE under
`licenses/`). The sdist must hold `sakk_gateway.py`, `README.pypi.md`,
LICENSE, NOTICE, `pyproject.toml` and PKG-INFO only. Anything else (tests,
`mock_provider.py`, a config) means the include list is wrong: stop.

## 2. Create the project with the first upload

PyPI creates a project on its first upload. The name `sakk-litellm` is not
reserved until then.

1. Sign in to pypi.org with two-factor authentication on.
2. Account settings → API tokens → Add API token, scope "Entire account"
   (a project scope exists only after the first upload).
3. Upload, and paste the token when twine asks for it, so it stays out of
   your shell history:

   ```bash
   uvx twine upload "$out"/*
   ```

   The username is `__token__`.

4. Check https://pypi.org/project/sakk-litellm/ shows the version, the
   Apache-2.0 licence and the readme.
5. Delete the account-wide token (Account settings → API tokens → Remove).

## 3. Trusted publisher for later releases

Later releases should publish from GitHub Actions with no stored token. On
the project page: Manage → Publishing → Add a new publisher → GitHub, owner
`sakk-dev`, repository `sakk`, the workflow file name of the release
workflow, and the environment `pypi`. Add the publisher when that workflow
exists; it is not part of this repository yet, so until then each release is
uploaded as in step 2 with a project-scoped token.

## 4. Check the install people will run

In a throwaway folder, the commands from `integrations/litellm/README.pypi.md`:
LiteLLM from the hash lock, then `sakk-litellm==<version>` with `--no-deps`,
then `python -c "import sakk_gateway"` with `SAKK_BIN`, `SAKK_LEDGER` and
`SAKK_GATEWAY_CONFIG` set. A module that imports and a proxy that starts
with `callbacks: sakk_gateway.handler` is the release done. LiteLLM loads
that callback from the folder of `config.yaml` when the file is there and
otherwise imports it by name, so the installed module is found
(`litellm/proxy/types_utils/utils.py`, `get_instance_fn`, 1.106.2).
