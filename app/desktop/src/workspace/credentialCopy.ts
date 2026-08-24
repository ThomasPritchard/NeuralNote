// What the app is allowed to promise about the user's API key, in one place.
//
// The two credential surfaces (the chat pane's first-run setup and the AI
// settings page) both used to say the key "never leaves this machine". That
// conflates two different guarantees and asserts the false one: storage in the
// keychain is a claim about the key *at rest* and is true; "never leaves this
// machine" is a claim about the key *in transit* and is false — it is
// bearer-auth'd to https://openrouter.ai on every chat turn and every
// model-catalogue refresh (issue #207). Transmitting it is the point of an
// OpenRouter key; only the sentence was wrong.
//
// It lives here rather than in either component because a second copy is how
// the first one got fixed and the other did not.

/** The one accurate statement of how NeuralNote handles the API key: where it
 *  rests, where it is sent, and that there is nowhere else. */
export const API_KEY_HANDLING_MESSAGE =
  "Your key is stored in your computer's keychain, never in a file NeuralNote " +
  "writes. It is sent to OpenRouter to authenticate your requests, and nowhere " +
  "else.";
