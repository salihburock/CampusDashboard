A dashboard to store course files with some extra features. Mainly built with AI.

## Setup

```
npm install
cp .env.example .env   # then set SESSION_SECRET
npm start
```

## Moodle sync

Set `MOODLE_URL` in `.env` to your university's Moodle. Each user then:

1. Opens **Account → Moodle**, drags the **Connect Dashboard** button to the bookmarks bar,
   opens Moodle (logged in) and clicks the bookmark. It gets a token from Moodle's mobile-app
   launch page (like the official app) and returns to `/account` with it in the URL fragment,
   which is removed from the address bar before the token is sent to the server. Pasting a
   web service token works too.
2. Clicks **🔄 Sync from Moodle** in the editor, picks courses and optionally grades.

Courses are matched by Moodle id, or by course code for courses added by hand. Upcoming
assignments and quizzes (what Moodle still lists as to-do) go into Homework; re-syncing
updates them and keeps rows added by hand. Grades are visible to anyone who can see the
courses section, so they are opt-in.

Tokens are stored per user in `userdata/<user>/moodle.json`, encrypted with a key derived from
`SESSION_SECRET` (changing it disconnects everyone). Only read-only web service functions are
called. The connect flow is adapted from [Mcp4Lms](https://github.com/threos/mcp4lms).
