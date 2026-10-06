import { DEVICES, SCENARIOS } from "./scenarios";

const t = document.getElementById("t") as HTMLTableElement;
t.innerHTML = `<tr><th>Scenario</th><th>View</th>${Object.values(DEVICES).map((d) => `<th>${d.label}</th>`).join("")}<th>Light</th></tr>`;
for (const s of SCENARIOS) {
  const links = (Object.keys(DEVICES) as Array<keyof typeof DEVICES>)
    .map((d) => `<td><a href="frame.html?s=${s.id}&device=${d}&fit=1${s.id === "ledger" ? "&click=See%20more" : ""}">${DEVICES[d].width}x${DEVICES[d].height}</a></td>`)
    .join("");
  t.insertAdjacentHTML("beforeend", `<tr><td>${s.title}</td><td>${s.view}</td>${links}<td><a href="frame.html?s=${s.id}&device=show8&theme=light&fit=1">light</a></td></tr>`);
}
