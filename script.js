const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeToggleBtnMobile = document.getElementById('theme-toggle-btn-mobile');
const body = document.body;
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light'){
    body.classList.add('light-mode')
    themeToggleBtn.innerHTML = '<i class="fa-regular fa-moon"></i>';
    themeToggleBtnMobile.innerHTML = '<i class="fa-regular fa-moon"></i>';
}


themeToggleBtn.addEventListener("click", () => {
    body.classList.toggle('light-mode');

    if(body.classList.contains('light-mode')){
        localStorage.setItem('theme', 'light');
        themeToggleBtn.innerHTML = '<i class="fa-regular fa-moon"></i>';
        themeToggleBtnMobile.innerHTML = '<i class="fa-regular fa-moon"></i>';
    }
    else{
        localStorage.setItem('theme', 'dark');
        themeToggleBtn.innerHTML = '<i class="fa-regular fa-sun"></i>';
        themeToggleBtnMobile.innerHTML = '<i class="fa-regular fa-sun"></i>';
    }
})

themeToggleBtnMobile.addEventListener("click", () => {
    body.classList.toggle('light-mode');

    if(body.classList.contains('light-mode')){
        localStorage.setItem('theme', 'light');
        themeToggleBtn.innerHTML = '<i class="fa-regular fa-moon"></i>';
        themeToggleBtnMobile.innerHTML = '<i class="fa-regular fa-moon"></i>';
    }
    else{
        localStorage.setItem('theme', 'dark');
        themeToggleBtn.innerHTML = '<i class="fa-regular fa-sun"></i>';
        themeToggleBtnMobile.innerHTML = '<i class="fa-regular fa-sun"></i>';
    }
})