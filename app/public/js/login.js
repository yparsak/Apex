// Login page behavior - posts to the existing JSON /auth/login endpoint
// (Phase 0) and redirects into the Phase 2 repo list on success.

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('d-none');

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try {
      await window.ApexApi.post('/auth/login', { username, password });
      window.location.href = '/repos';
    } catch (err) {
      errorBox.textContent = err.message || 'Login failed';
      errorBox.classList.remove('d-none');
    }
  });
});
