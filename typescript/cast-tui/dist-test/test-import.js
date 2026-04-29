async function test() {
    const mod = await Promise.resolve().then(() => require('@opentui/core'));
    console.log(mod);
}
