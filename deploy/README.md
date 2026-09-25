# Updating from inside Glassboard

With this wired up, **Settings → About** shows the installed version, what the
repository has, and an **Update now** button. A dot appears next to the account
button when a newer version is waiting.

The application never updates itself. It only writes a request file in its data
directory; systemd notices that file and runs the updater **as root**. So an
application that gets compromised still cannot rewrite its own code or call
`systemctl`.

```
 you click            the app writes              systemd sees the file
 "Update now"   ->    $DATA_DIR/update.request -> glassboard-update.path
                                                        |
                       status file  <---------  glassboard-update.service (root)
                    $DATA_DIR/update.status        downloads, installs,
                                                   swaps, restarts
```

## Install

Adjust the paths in the unit files if yours differ, then:

```bash
sudo install -m 755 deploy/glassboard-update.sh /usr/local/bin/glassboard-update
sudo install -m 644 deploy/glassboard-update.service deploy/glassboard-update.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now glassboard-update.path
```

Then turn the button on, in the application's own `.env`:

```
UPDATE_ENABLED=1
UPDATE_REPO=Lokyron/GlassBoard
UPDATE_BRANCH=main
```

and restart Glassboard. The application needs to be able to write its data
directory, which it already does; nothing else changes on its side.

## What the updater does

1. Downloads the branch as a tarball from GitHub into a staging directory next
   to the application, on the same filesystem.
2. Refuses to go on if the archive does not look like Glassboard.
3. Runs `npm ci --omit=dev` there.
4. Copies your `.env` over and writes a `VERSION` file with the commit it
   installed.
5. Swaps the directories with a rename, so the switch is as close to atomic as
   a directory gets, and restarts the service.
6. **Rolls back** if the service does not come up: the previous directory is put
   straight back and restarted, and the failure is reported in the interface.

The previous version is kept as `<app dir>.previous` until the new one is
confirmed running, and a failed one as `<app dir>.failed` for you to look at.

## Notes

- `VERSION` is written by the updater and ignored by git. Without it, the
  interface says the installed version is unknown, which is normal for a
  manual install.
- The check against GitHub is cached for `UPDATE_CHECK_HOURS` (24 by default),
  well inside the rate limit for anonymous calls.
- In Docker, leave `UPDATE_ENABLED` off: updating an image means pulling it and
  recreating the container, not rewriting files inside it.
- Updating pulls whatever is on the branch. Point `UPDATE_BRANCH` at a branch
  you control if you want to review changes before they land on your server.
