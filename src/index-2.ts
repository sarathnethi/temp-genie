type User = {
  id: number;
  name: string;
};

function greet(user: User): string {
  return `Hello, ${user.name} (id=${user.id})`;
}

function sum(a: number, b: number): number {
  return a + b;
}

async function main(): Promise<void> {
  const user: User = { id: 1, name: "Sarath" };

  console.log(greet(user));
  console.log("2 + 3 =", sum(2, 3));

  // Quick async check
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  await delay(200);
  console.log("Async works ✅");
}

main().catch((err) => {
  console.error("Error:", err);
  // process.exitCode = 1;
});
