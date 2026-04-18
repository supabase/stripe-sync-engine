#!/usr/bin/env bash
# Regenerate SVG and PNG from PlantUML source files.
# Requires: java
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLANTUML_VERSION="1.2024.7"
PLANTUML_JAR="/tmp/plantuml-${PLANTUML_VERSION}.jar"

if [ ! -f "$PLANTUML_JAR" ]; then
  echo "Downloading PlantUML ${PLANTUML_VERSION}..."
  curl -sL -o "$PLANTUML_JAR" \
    "https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml-${PLANTUML_VERSION}.jar"
fi

find "$REPO_ROOT/docs" -name '*.puml' | while read -r puml; do
  echo "Generating: $puml"
  java -jar "$PLANTUML_JAR" -tsvg "$puml"
  java -jar "$PLANTUML_JAR" -tpng "$puml"
done

echo "Done."
