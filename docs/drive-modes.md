# Drive attendance display

The five fixed UI modes are Own Location, Home Campus, Other Campus, External Venue and TBA. Home/other campus is relative to the student's known college campus, rather than hard-coded to Bhopal. Company offices, hotels and other confirmed external venues use External Venue.

Cards append a short confirmed physical destination, such as Other Campus · VIT Vellore or Home Campus · LC 102. Drive details retain each round's full venue, attendance mode and existing travel indicator. A remote assessment requiring CDC lab attendance is physical campus attendance. Confirmed physical rounds take priority over remote rounds on the card. Unknown evidence stays TBA, and an unknown student campus cannot be guessed when classifying home versus other campus.

The details-page Drive Mode value stays on one line, with its travel icon. Exact venues appear in the visible Round venues table rather than a hover dialog or a second line in the mode box. The user-provided Bhopal room alias L3103 → LC 103 applies only to UI formatting; original circular text and stored projections retain their evidence, and rooms at other campuses are not renamed.

For a Bhopal student, cards use Home Campus · LC whenever the short destination would otherwise be only VIT Bhopal, including respective-campus instructions without the word labs. This is the user's home-campus shorthand. Explicit rooms and named venues remain intact, and Other Campus · VIT Bhopal remains appropriate for students from another campus. Round venues retain the source venue; respective-campus lab instructions without a room use LC there as well.

`resolveDriveMode` is a read-only formatter over the existing drive-specific recruitment venue projection. It reuses the audience scoping, venue selection and travel calculation used by `resolveDriveVenue`. Dashboard, Companies, Search and drive details all use this formatter. Canonical data, statuses, event mode fields, notification text and sync delivery logic are not rewritten by the UI formatter. No migration, extra database read, deployment or production mutation is needed.
