const qInput = document.getElementById("q");
const goBtn = document.getElementById("go");
const outDiv = document.getElementById("out");
const copyBtn = document.getElementById("copy");

let lastPromptText = "";

function search() {
  const query = qInput.value.trim();
  if (!query) return;
  outDiv.textContent = "⏳ Se interoghează legislatie.just.ro...";
  copyBtn.style.display = "none";

  chrome.runtime.sendMessage({ type: "QUERY_LEGISLATIE", query }, (resp) => {
    if (!resp || !resp.ok) {
      outDiv.textContent = (resp && resp.error) || "Eroare la căutare.";
      return;
    }
    const { act, articole } = resp;
    const textBlocks = [
      `[ANCORARE LEGISLAȚIE OFICIALĂ LA ZI — legislatie.just.ro]`,
      `Act: ${act.tipAct} nr. ${act.numar} (${act.dataVigoare})`,
      `Link: ${act.linkHtml || "https://legislatie.just.ro"}`,
      `---`
    ];
    articole.forEach((a) => {
      textBlocks.push(a.content);
      textBlocks.push(`---`);
    });
    lastPromptText = textBlocks.join("\n");
    outDiv.textContent = lastPromptText;
    copyBtn.style.display = "block";
  });
}

goBtn.addEventListener("click", search);
qInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") search();
});

copyBtn.addEventListener("click", () => {
  if (!lastPromptText) return;
  navigator.clipboard.writeText(lastPromptText).then(() => {
    copyBtn.textContent = "✅ Copiat în Clipboard!";
    setTimeout(() => {
      copyBtn.textContent = "📋 Copiază pentru Prompt AI";
    }, 2000);
  });
});
