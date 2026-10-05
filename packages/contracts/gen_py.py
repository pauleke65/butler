"""Generate Pydantic v2 models from the JSON Schema produced by the TS contracts package."""
import subprocess, sys
from pathlib import Path

root = Path(__file__).parent
schema = root / "schemas" / "butler.schema.json"
out = root / "py" / "butler_contracts" / "models.py"
subprocess.run(
    [
        sys.executable, "-m", "datamodel_code_generator",
        "--input", str(schema), "--input-file-type", "jsonschema",
        "--output", str(out), "--output-model-type", "pydantic_v2.BaseModel",
        "--target-python-version", "3.12", "--use-standard-collections", "--use-union-operator",
        "--field-constraints", "--use-annotated", "--disable-timestamp",
        "--snake-case-field", "--allow-population-by-field-name",
        "--use-double-quotes", "--collapse-root-models", "--enum-field-as-literal", "all",
    ],
    check=True,
)
print("wrote", out)
