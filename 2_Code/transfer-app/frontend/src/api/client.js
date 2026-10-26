import axios from 'axios'

const TOKEN_KEY = 'transfer_auth_token'

const client = axios.create({
  baseURL: 'http://localhost:4000/api',
  headers: {
    'Content-Type': 'application/json'
  }
})

// Request interceptor: attach token
client.interceptors.request.use(
  config => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  error => Promise.reject(error)
)

// Response interceptor: handle 401
client.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem('transfer_user')
      // Redirect to login only if not already there
      if (!window.location.pathname.includes('/login') && !window.location.pathname.includes('/status')) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default client
