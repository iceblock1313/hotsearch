const PORT = 9900;
let index = 0
// async function test() {
//     const res = await fetch(`http://localhost:${PORT}/api/components/1-0-0-1/settings`,
//         {
//             // method: 'POST',
//             // headers: { 'Content-Type': 'application/json' },
//             // body: JSON.stringify({
//             //     ImagePath: imagePath[index]
//             // })
//         })
//     const data = await res.json();
//     console.log(data);
// }
// test()
const imagePath = { "#1": "#FF4444FF", "#2": "#FF8844FF", "#3": "#FFCC44FF", "#4": "#AAAAAAFF" }
setInterval(async () => {
    console.log(`正在更新组件设置，当前索引：${index}`, Object.keys(imagePath)[index], Object.values(imagePath)[index]);
    const resget = await fetch(`http://localhost:${PORT}/api/components/1-0-0-2/settings`,
        {
            // method: 'POST',
            // headers: { 'Content-Type': 'application/json' },
            // body: JSON.stringify({
            //     ImagePath: imagePath[index]
            // })
        })
    const dataget = await resget.json();
    console.log(dataget);
    const res = await fetch(`http://localhost:${PORT}/api/components/1-0-0-2/settings`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                TextContent: Object.keys(imagePath)[index],
                FontColor: Object.values(imagePath)[index]
            })
        })
    const data = await res.json();
    console.log(data);
    const saveRes = await fetch(`http://localhost:${PORT}/api/save`, {
        method: 'POST'
    });
    const saveData = await saveRes.json();
    console.log(saveData);
    if (index < Object.keys(imagePath).length - 1) {
        index++;
    } else {
        index = 0;
    }
}, 2000)
