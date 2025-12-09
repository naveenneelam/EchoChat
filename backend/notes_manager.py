import os
import re
from datetime import datetime

# === CONFIG ===
NOTES_DIR = "./notes"  # folder where all context files live
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def ensure_notes_dir():
    """Ensure the notes folder exists."""
    if not os.path.exists(NOTES_DIR):
        os.makedirs(NOTES_DIR)


def get_file_path(context: str) -> str:
    """Return file path for the given context (like 'todolist')."""
    ensure_notes_dir()
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", context.lower())
    return os.path.join(NOTES_DIR, f"{safe_name}.txt")


def read_file(filepath: str) -> str:
    """Return the text contents of a file, or empty if it doesn’t exist."""
    if not os.path.exists(filepath):
        return ""
    with open(filepath, "r", encoding="utf-8") as f:
        return f.read()


def write_file(filepath: str, content: str):
    """Write text to file (overwrite)."""
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)


def append_to_file(filepath: str, new_text: str):
    """Append text to file."""
    with open(filepath, "a", encoding="utf-8") as f:
        f.write("\n" + new_text.strip() + "\n")


def insert_or_update_date_entry(filepath: str, date: str, text: str):
    """
    Insert or update a dated entry.
    Each dated entry looks like:
        ## 2025-10-07
        - Do something important
    """
    content = read_file(filepath)
    pattern = rf"(##\s*{re.escape(date)}\s*\n)(.*?)(?=\n##\s*\d{{4}}-\d{{2}}-\d{{2}}|\Z)"
    match = re.search(pattern, content, flags=re.DOTALL)

    if match:
        # Replace existing date block
        updated = re.sub(pattern, f"## {date}\n{text.strip()}\n", content, flags=re.DOTALL)
        write_file(filepath, updated)
        print(f"✅ Updated entry for {date} in {filepath}")
    else:
        # Append new date section
        new_entry = f"\n## {date}\n{text.strip()}\n"
        append_to_file(filepath, new_entry)
        print(f"✅ Added new entry for {date} in {filepath}")


def delete_date_entry(filepath: str, date: str):
    """Delete a dated entry."""
    content = read_file(filepath)
    pattern = rf"(##\s*{re.escape(date)}\s*\n.*?)(?=\n##\s*\d{{4}}-\d{{2}}-\d{{2}}|\Z)"
    new_content = re.sub(pattern, "", content, flags=re.DOTALL)
    if new_content != content:
        write_file(filepath, new_content.strip() + "\n")
        print(f"🗑️ Deleted entry for {date} in {filepath}")
    else:
        print(f"⚠️ No entry found for {date} in {filepath}")


def process_instruction(context: str, action: str, text: str = "", date: str = None):
    """
    Process a single instruction:
        context: 'todolist' | 'linuxnotes' | 'electronics'
        action: 'append' | 'update' | 'insert' | 'delete'
        text: text content (for all except delete)
        date: optional date (default today)
    """
    filepath = get_file_path(context)
    if not date:
        date = datetime.now().strftime(DATE_FORMAT)

    if action == "append":
        append_to_file(filepath, text)
        print(f"✅ Appended to {filepath}")
    elif action in ("insert", "update"):
        insert_or_update_date_entry(filepath, date, text)
    elif action == "delete":
        delete_date_entry(filepath, date)
    else:
        print(f"❌ Unknown action: {action}")


# === Example Usage ===
if __name__ == "__main__":
    """
    Example scenarios:
      - Create or update today's entry in 'todolist'
      - Append quick note to 'linuxnotes'
      - Delete today's entry from 'electronics'
    """

    # Create/update today's task list
    process_instruction(
        context="todolist",
        action="update",
        text="- Buy multimeter\n- Check ESP32 relay issue"
    )

    # Append a one-liner to linuxnotes
    process_instruction(
        context="linuxnotes",
        action="append",
        text="use 'journalctl -fu nginx' to stream logs live"
    )

    # Delete today's entry in electronics
    process_instruction(
        context="electronics",
        action="delete"
    )
 