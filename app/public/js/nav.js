// Shared header behavior (logout) for any page that includes
// partials/header.ejs.

document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) return;

  logoutBtn.addEventListener('click', async () => {
    try {
      await window.ApexApi.post('/auth/logout');
    } finally {
      window.location.href = '/login';
    }
  });
});
