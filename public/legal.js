// Privacy policy, Terms of service, Cookie policy and the data-deletion request form.
// Written for an event run in India for school children (Digital Personal Data Protection Act, 2023). It is a plain-language draft:
// have your legal adviser review it before the event, and bump POLICY_VERSION in src/config.js when it changes.

const PAGES = { privacy: 'Privacy Policy', terms: 'Terms of Service', cookies: 'Cookie Policy', delete: 'Delete my data' };

const body = (kind, mail) => ({
  privacy: `
    <p class="muted">Last updated: October 2026. Promptathon is run by <b>The AI Club</b> (“we”, “us”). We know our players are children, so we collect as little as we can and use it only to run the event.</p>
    <h2>What we collect</h2>
    <ul>
      <li><b>From the parent or guardian’s sign-in (Google):</b> name, email address and profile picture. We never see your password.</li>
      <li><b>About each child:</b> name, grade, school, an optional phone number, and the student code we create.</li>
      <li><b>During the event:</b> answers, scores, which lifelines were used, time taken, and a note if the child left the test window.</li>
      <li><b>Consent records:</b> when a parent or guardian agreed, and to which version of this policy.</li>
    </ul>
    <h2>Why we use it</h2>
    <ul>
      <li>To let your child take part, mark the rounds and show results and leaderboards.</li>
      <li>To keep the event fair (for example, noticing when the test window is left).</li>
      <li>To email a score card, if the event offers one, to the account email.</li>
    </ul>
    <p>We do <b>not</b> sell children’s data, show ads, build behavioural profiles, or track children across other websites.</p>
    <h2>Children and consent</h2>
    <p>Under India’s Digital Personal Data Protection Act, 2023, a child is anyone under 18 and a parent or guardian must give consent. That is why a parent or guardian ticks a consent box each time a student is added. You can withdraw consent at any time by using <a href="#/legal/delete">Delete my data</a>.</p>
    <h2>Who sees it</h2>
    <ul>
      <li>The event hosts and their schools’ organisers, to run the event.</li>
      <li>Other players see only a leaderboard (a name, school and score; the host decides how wide the leaderboard is).</li>
      <li>Service providers that store or process data for us: Google (Sheets and Drive store our records), Anthropic (an AI model may help mark written answers; answers are sent without account email), and an email service for score cards.</li>
    </ul>
    <p>Your data may be stored on servers outside India. We only use providers that protect it appropriately.</p>
    <h2>How long we keep it</h2>
    <p>Until the event and its results are finished, plus up to 12 months for appeals and records, unless you ask us to delete it sooner. After that we erase or anonymise it.</p>
    <h2>Your rights</h2>
    <p>You (as parent or guardian) can ask to see, correct or erase your child’s data, withdraw consent, or nominate someone to act for you. Use <a href="#/legal/delete">Delete my data</a> or email us.</p>
    <h2>Security</h2>
    <p>Data travels over encrypted connections, access to host tools is limited to named hosts, and test pages are protected against copying. No system is perfectly secure; if there is a data breach that affects you we will tell you and the Data Protection Board of India as the law requires.</p>
    <h2>Grievances and contact</h2>
    <p>Questions or complaints? Write to <a href="mailto:${mail}">${mail}</a>. We aim to reply within 7 days. If you are not satisfied you may complain to the Data Protection Board of India.</p>`,
  terms: `
    <p class="muted">Last updated: October 2026. By signing in or adding a student you accept these terms. If you are under 18, a parent or guardian must accept them for you.</p>
    <h2>The event</h2>
    <p>Promptathon is a timed, three-round challenge about thinking carefully with AI. Details such as dates, rounds and scoring are shown inside the app and may be changed by the hosts.</p>
    <h2>Accounts</h2>
    <ul><li>Sign in with your own Google account. One account can hold several students (for example, brothers and sisters).</li>
      <li>Give correct details: the name, grade and school must be the child’s own.</li></ul>
    <h2>Play fair</h2>
    <ul>
      <li>Use your own ideas. Do not copy, share or get answers from others.</li>
      <li>Do not copy, paste, screenshot, record or share questions or answers, or try to get around the test protections.</li>
      <li>Stay in the test window during a round. If you must leave, ask the host to let you continue; the clock is paused until they do.</li>
      <li>Do not type personal details, such as an address, phone number or password, into answers.</li>
    </ul>
    <p>The hosts may pause, end or restart a test, remove a result, or disqualify a player who breaks these rules. Their decision on scores is final.</p>
    <h2>Your answers</h2>
    <p>Your answers stay yours. You allow us to store, mark and display them (with a name, school and score) for the event, and to use anonymised results to improve it.</p>
    <h2>Our content</h2>
    <p>Questions, comics, the character Foldling and the site design belong to The AI Club or its licensors. Please do not copy or republish them.</p>
    <h2>Availability and liability</h2>
    <p>We try hard to keep Promptathon running, but we can’t promise it will always be available or error-free. To the extent the law allows, we are not responsible for indirect losses from using it. Nothing here limits any right you have under Indian law.</p>
    <h2>Changes and law</h2>
    <p>We may update these terms; the date above will change. These terms are governed by the laws of India, and the courts at the event organiser’s registered location have jurisdiction.</p>
    <p>Questions: <a href="mailto:${mail}">${mail}</a></p>`,
  cookies: `
    <p class="muted">Last updated: October 2026.</p>
    <h2>What are cookies?</h2>
    <p>Cookies are small files that a website saves in your browser.</p>
    <h2>What we use</h2>
    <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>What it does</th><th>How long</th><th>Type</th></tr></thead><tbody>
      <tr><td><code>pt</code></td><td>Keeps you signed in and remembers which student is playing.</td><td>7 days</td><td>Essential</td></tr>
      <tr><td><code>pt_state</code></td><td>A short check that protects the sign-in from being hijacked.</td><td>10 minutes</td><td>Essential</td></tr>
      <tr><td>Browser storage</td><td>Remembers your reading settings (text size, font, theme), your answers on this device as a backup, and that you saw the cookie notice.</td><td>Until you clear it</td><td>Essential / preference</td></tr>
    </tbody></table></div>
    <h2>What we do not use</h2>
    <p>No advertising cookies, no analytics or tracking cookies, and nothing that follows children across other sites. Because every cookie we use is essential for the site to work, there is nothing to switch on or off. If that changes, we will ask first.</p>
    <p>Signing in with Google happens on Google’s page, and Google may set its own cookies under its own policy.</p>
    <h2>Control</h2>
    <p>You can delete cookies in your browser settings; you would then have to sign in again.</p>`,
})[kind];

export function renderLegal(main, kind, { cfg, api, toast, esc }) {
  if (!PAGES[kind]) kind = 'privacy';
  const mail = esc(cfg?.contact || '');
  const tabs = Object.entries(PAGES).map(([k, t]) => `<a href="#/legal/${k}" ${k === kind ? 'aria-current="page"' : ''}>${t}</a>`).join('');
  main.innerHTML = `<div class="wrap"><div class="legal">
    <nav class="legal-tabs" aria-label="Legal pages">${tabs}</nav>
    <h1>${PAGES[kind]}</h1>
    ${kind === 'delete' ? `<p>You can ask us to delete a child’s data, or your own. A host will check the request and reply to the email you give, usually within 7 days.</p>
      <form id="del-form" class="card stack" style="max-width:560px">
        <div class="field"><label for="dl-name">Your name</label><input id="dl-name" name="name" type="text" required maxlength="80" autocomplete="name"></div>
        <div class="field"><label for="dl-contact">Email to reply to</label><input id="dl-contact" name="contact" type="email" required maxlength="120" autocomplete="email"></div>
        <div class="field"><label for="dl-code">Student code <span class="hint">(optional, like BZ-ABC12)</span></label><input id="dl-code" name="code" type="text" maxlength="20"></div>
        <div class="field"><label for="dl-details">What should we delete? <span class="hint">(optional)</span></label><textarea id="dl-details" name="details" maxlength="600" placeholder="For example: all of my child’s data, or just the phone number."></textarea></div>
        <label class="check"><input type="checkbox" name="ok" required><span class="small">I am the person this data is about, or this child’s parent or legal guardian.</span></label>
        <button class="btn">Send request</button>
      </form>` : body(kind, mail)}
  </div></div>`;
  main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  const form = main.querySelector('#del-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      await api('/api/deletion', { name: f.name, contact: f.contact, code: f.code, details: f.details });
      form.outerHTML = '<div class="note" role="status"><b>Request received.</b> Thank you. A host will reply to your email soon.</div>';
    } catch (err) { toast(err.message); }
  });
}
