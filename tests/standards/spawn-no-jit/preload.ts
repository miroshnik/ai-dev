// Preload прогона (bunfig.toml): на macOS дочерние процессы bun — без JIT, причина — spawn-no-jit.md. Сам прогон уже
// запущен с JIT: JSC читает переменную только при старте процесса.
if (process.platform === "darwin") process.env.BUN_JSC_useJIT = "0";
