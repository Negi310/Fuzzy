/*=========================================
    Fuzitter Website
=========================================*/

// =========================
// Fade Animation
// =========================

const fadeElements = document.querySelectorAll(
    ".section, .downloadSection, .card"
);

const observer = new IntersectionObserver(

(entries)=>{

    entries.forEach(entry=>{

        if(entry.isIntersecting){

            entry.target.classList.add("show");

        }

    });

},
{
    threshold:0.15
}

);

fadeElements.forEach(element=>{

    element.classList.add("fade");

    observer.observe(element);

});

// =========================
// Header Shadow
// =========================

const header = document.querySelector("header");

window.addEventListener("scroll",()=>{

    if(window.scrollY>30){

        header.style.boxShadow=
        "0 10px 30px rgba(0,0,0,.08)";

    }

    else{

        header.style.boxShadow="none";

    }

});

// =========================
// Smooth Hero Motion
// =========================

const heroImage=document.querySelector(".heroImage img");

document.addEventListener("mousemove",(e)=>{

    const x=(e.clientX/window.innerWidth)-0.5;

    const y=(e.clientY/window.innerHeight)-0.5;

    heroImage.style.transform=

    `
    rotateY(${x*10}deg)
    rotateX(${-y*10}deg)
    translateY(-8px)
    `;

});

// =========================
// Screenshot Hover
// =========================

const screenshots=document.querySelectorAll(".slider img");

screenshots.forEach(img=>{

    img.addEventListener("click",()=>{

        img.animate(

        [

            {

                transform:"scale(1)"

            },

            {

                transform:"scale(1.06)"

            },

            {

                transform:"scale(1)"

            }

        ],

        {

            duration:350

        });

    });

});

// =========================
// Download Button Effect
// =========================

const buttons=document.querySelectorAll(

".primary,.downloadBig,.downloadButton"

);

buttons.forEach(button=>{

button.addEventListener("mouseenter",()=>{

button.animate(

[

{

transform:"translateY(0)"

},

{

transform:"translateY(-6px)"

},

{

transform:"translateY(0)"

}

],

{

duration:350

}

);

});

});

// =========================
// Number Count Animation
// =========================

function animateValue(element,start,end,duration){

let startTime=null;

function animation(currentTime){

if(!startTime)

startTime=currentTime;

const progress=Math.min(

(currentTime-startTime)/duration,

1

);

element.textContent=Math.floor(

progress*(end-start)+start

);

if(progress<1){

requestAnimationFrame(animation);

}

}

requestAnimationFrame(animation);

}

// =========================
// Floating Cards
// =========================

const cards=document.querySelectorAll(".card");

cards.forEach((card,index)=>{

card.animate(

[

{

transform:"translateY(0px)"

},

{

transform:"translateY(-10px)"

},

{

transform:"translateY(0px)"

}

],

{

duration:3000+index*400,

iterations:Infinity,

direction:"alternate",

easing:"ease-in-out"

}

);

});

// =========================
// Simple Screenshot Carousel
// =========================

let current=0;

const screenshotImages=document.querySelectorAll(".slider img");

function updateScreenshotCarousel(){

    screenshotImages.forEach(img=>{

        img.classList.remove("active");

    });

    screenshotImages[current].classList.add("active");

    current++;

    if(current>=screenshotImages.length){

        current=0;

    }

}

if(screenshotImages.length>0){

    updateScreenshotCarousel();

    setInterval(updateScreenshotCarousel,2500);

}

// =========================
// Scroll Progress Bar
// =========================

const progress=document.createElement("div");

progress.style.position="fixed";
progress.style.top="0";
progress.style.left="0";
progress.style.height="4px";
progress.style.background="#FFD84D";
progress.style.width="0";
progress.style.zIndex="99999";

document.body.appendChild(progress);

window.addEventListener("scroll",()=>{

const scroll=

document.documentElement.scrollTop;

const height=

document.documentElement.scrollHeight-

document.documentElement.clientHeight;

const width=

(scroll/height)*100;

progress.style.width=

width+"%";

});

// =========================
// Console Message
// =========================

console.log(

"%cFuzitter",

"font-size:40px;font-weight:bold;color:#FFD84D"

);

console.log(

"Thank you for visiting!"

);

// =========================
// Latest Release Download
// =========================

const latestDownloadButtons=document.querySelectorAll(

".js-latest-download"

);

const latestReleaseApiUrl=
"https://api.github.com/repos/Negi310/Fuzzy/releases/latest";

let latestExeUrlPromise=null;

async function resolveLatestExeUrl(){

if(!latestExeUrlPromise){

latestExeUrlPromise=fetch(latestReleaseApiUrl)
.then(response=>{

if(!response.ok){

throw new Error("Failed to fetch latest release.");

}

return response.json();

})
.then(release=>{

const asset=release.assets.find(item=>
/^Fuzitter-Setup-.*\.exe$/i.test(item.name)
);

if(!asset){

throw new Error("Latest release exe asset was not found.");

}

return asset.browser_download_url;

});

}

return latestExeUrlPromise;

}

latestDownloadButtons.forEach(button=>{

button.addEventListener("click",async event=>{

const fallbackUrl=
button.dataset.fallbackUrl||button.href;

try{

event.preventDefault();

const latestExeUrl=await resolveLatestExeUrl();

button.href=latestExeUrl;

window.location.href=latestExeUrl;

}

catch(error){

console.warn(error);

button.href=fallbackUrl;

}

});

});

resolveLatestExeUrl()
.then(latestExeUrl=>{

latestDownloadButtons.forEach(button=>{

button.href=latestExeUrl;

});

})
.catch(error=>{

console.warn(error);

});
