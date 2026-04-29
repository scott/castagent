# Cast Python Runtime
# Entry point for builder and runtime agents

import asyncio
import sys

async def main():
    if len(sys.argv) < 2:
        print("Usage: python -m cast <builder|runtime>")
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == "builder":
        from .builder import main as builder_main
        await builder_main()
    elif command == "runtime":
        from .runtime import main as runtime_main
        await runtime_main()
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
