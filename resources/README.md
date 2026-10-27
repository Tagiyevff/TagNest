# Bundled Linux base image (optional)

Run `npm run provision:linux` to download the pinned Alpine cloud image here.
The app copies it into the user data directory on first launch and keeps all user files in a separate qcow2 overlay, so replacing this base image never deletes a workspace.

This directory is git-ignored for *.qcow2 files.
