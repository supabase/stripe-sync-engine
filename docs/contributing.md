# Contributing

Contributions are welcome! This document provides guidelines for contributing to the Stripe Sync Engine project.

## Contributing to the Docs

Building documentation requires Python 3.8+ and uv.

### Install Dependencies

Create a virtual environment and install mkdocs, themes, and extensions using uv.

```sh
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -r docs/requirements_docs.txt
```

### Serving

To serve the documentation locally, make sure your virtual environment is activated and run:

```sh
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
mkdocs serve
```

and visit the docs at [http://127.0.0.1:8000/](http://127.0.0.1:8000/)

### Deploying

If you have write access to the repository, documentation can be updated using:

```sh
mkdocs gh-deploy
```
