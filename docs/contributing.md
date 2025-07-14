# Contributing

Contributions are welcome.

## Contributing to the Docs

Building documentation requires Python 3.8+ and uv.

### Install Dependencies

Create a virtual environment and install mkdocs, themes, and extensions using uv.

```shell
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -r docs/requirements_docs.txt
```

### Serving

To serve the documentation locally, make sure your virtual environment is activated and run:

```shell
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
mkdocs serve
```

and visit the docs at [http://127.0.0.1:8000/](http://127.0.0.1:8000/)

### Deploying

If you have write access to the repo, docs can be updated using

```
mkdocs gh-deploy
```
