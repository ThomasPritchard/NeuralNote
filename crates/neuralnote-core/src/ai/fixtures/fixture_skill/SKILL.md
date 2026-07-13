# Fixture skill

Use this built-in workflow to prove the skills framework without depending on a
network service or a downloaded binary.

1. Call `skill_step` with a short progress message.
2. Call `ask_user` with a single-select Continue / Stop choice.
3. If the user chooses Continue, call `write_note` with `work_item` 0 to create a
   small literature note in the path requested by the user.
4. Report the actual path returned by `write_note`. Never claim a note was written
   when the tool returned an error or an existing atomic note.
