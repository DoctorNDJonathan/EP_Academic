// Shown instead of a page that is blocked during the exam. Offers links to the allowed sites:
// a plain "Back" would return to the blocked page and be blocked again.
document.getElementById("site").textContent = decodeURIComponent(location.hash.slice(1)) || "This site";
chrome.storage.local.get("state").then(({ state }) => {
  if (!state) return;
  document.getElementById("exam").textContent = state.name || "this exam";
  const box = document.getElementById("sites");
  for (const entry of state.allowed_sites || []) {
    const a = document.createElement("a");
    a.href = `https://${entry}`;
    a.textContent = entry;
    box.appendChild(a);
  }
});
