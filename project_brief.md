# Project Overview: USB to Google Photos Auto-Upload Hub (Native Linux App)

Act as an expert Full-Stack Developer and Linux Systems Engineer. I need to build a native Linux web application that serves as an automated media ingestion and cloud upload hub. This must run directly on the host OS, not in a Docker container. 

Crucially, this system must feature persistent, granular logging to track exactly which files succeed or fail during both the copy and upload phases, surviving system restarts.

## Core Architecture & Database (New)
* **Database:** Use SQLite to persist run history and file statuses.
* **Data Schema:** * `runs`: id, start_time, end_time, usb_identifier, overall_status (in_progress, completed, partial_failure, failed).
    * `files`: id, run_id, filename, copy_status (pending, success, failed), upload_status (pending, success, failed), error_message.

## Core Workflow
1. A USB drive is physically inserted into the Linux server.
2. The system detects the drive, creates a new `run` record in SQLite, and maps the files to be processed.
3. The system mounts and copies media to a local `/staging` directory, updating the `copy_status` for each file in the database in real-time.
4. Upon copy completion, it safely ejects the USB drive.
5. The system uploads the staged files to Google Photos using `https://github.com/xob0t/google_photos_mobile_client`, updating the `upload_status` in the database for each file.
6. A web interface provides real-time progress and a persistent historical view of all runs.

## Tech Stack Requirements:
* **Backend:** Python (FastAPI or Flask), SQLite, SQLAlchemy (or raw SQLite3). Must run in an isolated Python `venv`.
* **Frontend:** HTML, CSS (Tailwind), Vanilla JS (or lightweight React/Vue).
* **Communication:** WebSockets for real-time progress streaming.
* **Deployment:** Native Linux deployment (`systemd` and `udev`).

## Module 1: Hardware Ingestion & Tracking Service
* Use host `udev` rules or `pyudev` for USB detection.
* **Pre-flight Check:** When mounted, index all target files on the USB and insert them into the `files` database table as `pending`.
* Perform the copy (via chunking or `rsync`). Catch specific file read/write errors.
* Update SQLite: If a file copies successfully, mark `copy_status = 'success'`. If it fails, mark `failed` and log the error.
* Emit WebSockets events: `copy_progress`, `file_copy_success`, `file_copy_failed` (with filename).
* Unmount safely and emit `usb_ejected`.

## Module 2: Google Photos Upload & Tracking Service
* Integrate `https://github.com/xob0t/google_photos_mobile_client` natively.
* Parse the client's output per file.
* Update SQLite: If a file uploads successfully, mark `upload_status = 'success'`. If it fails, mark `failed` and log the error.
* Emit WebSockets events: `upload_progress`, `file_upload_success`, `file_upload_failed`.

## Module 3: Web UI & Dashboard
* **Layout:** A tabbed or sidebar-navigated interface containing three main views:
    * **View 1: Live Dashboard (Split Screen)**
        * **Left (Local Copy):** USB status, overall progress bar (e.g., "Copied 45/50 files"). Must explicitly highlight files that failed to copy in red.
        * **Right (Cloud Upload):** Upload status, overall progress bar. Must explicitly highlight files that failed to upload in red.
        * **Overall Status Banner:** When a run finishes, display a clear "100% Copied & Uploaded" success message, OR a "Completed with Errors" warning that lists the specific failed files.
    * **View 2: Historical Reports (Persistent)**
        * A table listing all past runs (Date, USB Name, Total Files, Success Rate).
        * Clicking a run expands it to show a detailed audit log: exact files that were copied, which ones failed, and the specific error messages associated with the failures. This data is pulled from SQLite.
    * **View 3: Settings Page**
        * Credentials for Google Photos, staging directory paths, and cleanup toggles.

## Module 4: Native Deployment Instructions
1. Provide an `install.sh` to set up dependencies, the Python `venv`, directories, and initialize the SQLite database schema.
2. Provide the `.service` file configuration for `systemd`.
3. Provide the specific `udev` rules required for host-level USB detection.

## Output Requirements
Output the complete directory structure, the full Python backend code (including SQLite integration), the HTML/JS frontend code (with the live and history views), and the specific Linux configuration files required.