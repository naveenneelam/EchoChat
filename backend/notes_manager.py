import os
import re
from datetime import datetime
from typing import Dict, Any, Optional

# === CONFIG ===
NOTES_DIR = "./notes" # folder where all context files live
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# --- RESULT STRUCTURE ---
# All main action functions will return a dictionary like this:
# {
#     "success": bool,
#     "message": str,
#     "intent": str,    # e.g., 'insert_or_update', 'append', 'delete'
#     "context": str,   # e.g., 'todolist'
#     "action": str,    # e.g., 'update', 'append', 'delete' (from process_instruction)
#     "filepath": str,  # The file that was operated on
#     "date": Optional[str] # For dated operations
# }

def ensure_notes_dir():
    """Ensure the notes folder exists."""
    if not os.path.exists(NOTES_DIR):
        os.makedirs(NOTES_DIR)

def get_file_path(context: str) -> str:
    """Return file path for the given context (like 'todolist')."""
    ensure_notes_dir()
    # Use a safe name derived from the context
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", context.lower())
    return os.path.join(NOTES_DIR, f"{safe_name}.txt")

# --- LOW-LEVEL FILE I/O (Kept simple, can be extended for error handling) ---

def read_file(filepath: str) -> str:
    """Return the text contents of a file, or empty if it doesn’t exist."""
    if not os.path.exists(filepath):
        return ""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()
    except IOError as e:
        print(f"Error reading file {filepath}: {e}")
        return ""

def write_file(filepath: str, content: str):
    """Write text to file (overwrite)."""
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
    except IOError as e:
        print(f"Error writing file {filepath}: {e}")

# --- INTENT-DRIVEN HELPER FUNCTIONS ---

def append_to_file_intent(filepath: str, new_text: str, context: str) -> Dict[str, Any]:
    """Append text to file and return status."""
    intent = "append"
    try:
        with open(filepath, "a", encoding="utf-8") as f:
            f.write("\n" + new_text.strip() + "\n")
        return {
            "success": True,
            "message": f"Successfully appended content to {context}",
            "intent": intent,
            "context": context,
            "action": intent,
            "filepath": filepath,
            "date": None,
        }
    except IOError as e:
        return {
            "success": False,
            "message": f"Failed to append to {context}: {e}",
            "intent": intent,
            "context": context,
            "action": intent,
            "filepath": filepath,
            "date": None,
        }

def insert_or_update_date_entry(filepath: str, date: str, text: str, context: str) -> Dict[str, Any]:
    """
    Insert or update a dated entry and return status.
    Each dated entry looks like:
        ## 2025-10-07
        - Do something important
    """
    intent = "insert_or_update"
    try:
        content = read_file(filepath)
        # Pattern to find a date block (starts with ## YYYY-MM-DD and ends before the next ## or EOF)
        pattern = rf"(##\s*{re.escape(date)}\s*\n)(.*?)(?=\n##\s*\d{{4}}-\d{{2}}-\d{{2}}|\Z)"
        match = re.search(pattern, content, flags=re.DOTALL)

        new_entry_content = f"## {date}\n{text.strip()}\n"

        if match:
            # Replace existing date block
            updated = re.sub(pattern, new_entry_content, content, flags=re.DOTALL)
            write_file(filepath, updated)
            action = "update"
            message = f"Successfully **updated** entry for {date} in context '{context}'."
        else:
            # Append new date section
            # Ensure content starts with a newline if not empty
            content_to_write = content.strip() + "\n" + new_entry_content
            write_file(filepath, content_to_write)
            action = "insert"
            message = f"Successfully **inserted** new entry for {date} in context '{context}'."

        return {
            "success": True,
            "message": message,
            "intent": intent,
            "context": context,
            "action": action,
            "filepath": filepath,
            "date": date,
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Failed to perform {intent} on '{context}' for date {date}: {e}",
            "intent": intent,
            "context": context,
            "action": None,
            "filepath": filepath,
            "date": date,
        }

def delete_date_entry(filepath: str, date: str, context: str) -> Dict[str, Any]:
    """Delete a dated entry and return status."""
    intent = "delete_entry"
    action = "delete"
    try:
        content = read_file(filepath)
        # Pattern to find and remove the date block (starts with ## YYYY-MM-DD and ends before the next ## or EOF)
        pattern = rf"\n?(##\s*{re.escape(date)}\s*\n.*?)(?=\n##\s*\d{{4}}-\d{{2}}-\d{{2}}|\Z)"
        new_content = re.sub(pattern, "", content, flags=re.DOTALL).strip()

        if len(new_content) < len(content): # Check if any change occurred
            write_file(filepath, new_content + "\n")
            message = f"Successfully **deleted** entry for {date} in context '{context}'."
            success = True
        else:
            message = f"No entry found for {date} in context '{context}'. Nothing was deleted."
            success = False

        return {
            "success": success,
            "message": message,
            "intent": intent,
            "context": context,
            "action": action,
            "filepath": filepath,
            "date": date,
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Failed to perform {action} on '{context}' for date {date}: {e}",
            "intent": intent,
            "context": context,
            "action": action,
            "filepath": filepath,
            "date": date,
        }


# --- MAIN DISPATCHER FUNCTION ---

def process_instruction(context: str, action: str, text: str = "", date: str = None) -> Dict[str, Any]:
    """
    Process a single instruction and return a result dictionary.
    """
    filepath = get_file_path(context)
    # Default date for dated actions (insert/update/delete)
    if not date:
        date = datetime.now().strftime(DATE_FORMAT)

    if action == "append":
        return append_to_file_intent(filepath, text, context)

    elif action in ("insert", "update"):
        # The underlying function handles both insert and update logic
        return insert_or_update_date_entry(filepath, date, text, context)

    elif action == "delete":
        # The underlying function handles the deletion logic
        return delete_date_entry(filepath, date, context)

    else:
        # Unknown action handler
        return {
            "success": False,
            "message": f"Unknown action requested: '{action}'. Valid actions are 'append', 'insert', 'update', 'delete'.",
            "intent": "unknown_action",
            "context": context,
            "action": action,
            "filepath": filepath,
            "date": date,
        }


# === Example Usage ===
if __name__ == "__main__":

    print("--- Running Examples ---")

    """# 1. Create/update today's task list (Action: update/insert)
    result_1 = process_instruction(
        context="todolist",
        action="update",
        text="- Buy multimeter\n- Check ESP32 relay issue"
    )
    print(f"\nResult 1:\n{result_1}")

    # 2. Append a one-liner to linuxnotes (Action: append)
    result_2 = process_instruction(
        context="linuxnotes",
        action="append",
        text="use 'journalctl -fu nginx' to stream logs live"
    )
    print(f"\nResult 2:\n{result_2}")

    # 3. Delete today's entry in electronics (Action: delete)
    result_3 = process_instruction(
        context="electronics",
        action="delete"
    )
    print(f"\nResult 3:\n{result_3}")

    # 4. Attempt to delete again (Should fail/report no-op)
    result_4 = process_instruction(
        context="electronics",
        action="delete"
    )
    print(f"\nResult 4:\n{result_4}")

    # 5. Invalid action
    result_5 = process_instruction(
        context="test_file",
        action="invalid_action",
        text="some text"
    )
    print(f"\nResult 5:\n{result_5}")"""