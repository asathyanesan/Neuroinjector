import os
from pathlib import Path

# Folders/files to exclude from structure dump
EXCLUDE_DIRS = {".git", "__pycache__", ".venv", "env", "node_modules", "brain_data"}
EXCLUDE_EXTS = {".pyc", ".DS_Store"}

def print_directory_tree(root_dir: Path, prefix: str = ""):
    """Recursively walks local directory and prints an ASCII tree."""
    contents = [
        p for p in root_dir.iterdir() 
        if p.name not in EXCLUDE_DIRS and p.suffix not in EXCLUDE_EXTS
    ]
    contents.sort(key=lambda x: (not x.is_dir(), x.name.lower()))

    pointers = ["├── "] * (len(contents) - 1) + ["└── "]
    for pointer, path in zip(pointers, contents):
        icon = "📁 " if path.is_dir() else "📄 "
        print(f"{prefix}{pointer}{icon}{path.name}")
        
        if path.is_dir():
            extension = "│   " if pointer == "├── " else "    "
            print_directory_tree(path, prefix=prefix + extension)

if __name__ == "__main__":
    repo_path = Path(".")  # Current working directory
    print(f"\n📂 Local Structure for: {repo_path.resolve().name}\n" + "="*40)
    print_directory_tree(repo_path)