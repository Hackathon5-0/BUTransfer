import React, { createContext, useState, useEffect, useCallback } from 'react'
import client from '../api/client'
import toast from 'react-hot-toast'

export const AuthContext = createContext(null)

const TOKEN_KEY = 'transfer_auth_token'
const USER_KEY = 'transfer_user'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [loading, setLoading] = useState(true)

  // On mount: verify stored token
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY)
    const storedUser = localStorage.getItem(USER_KEY)

    if (storedToken && storedUser) {
      setToken(storedToken)
      setUser(JSON.parse(storedUser))
      // Verify token is still valid
      client.get('/auth/me', {
        headers: { Authorization: `Bearer ${storedToken}` }
      })
        .then(res => {
          setUser(res.data.user || res.data)
          localStorage.setItem(USER_KEY, JSON.stringify(res.data.user || res.data))
        })
        .catch(() => {
          // Token invalid — clear auth
          clearAuth()
        })
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  const clearAuth = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setUser(null)
    setToken(null)
  }, [])

  const login = useCallback(async (email, password) => {
    const res = await client.post('/auth/login', { email, password })
    const { token: newToken, user: newUser } = res.data
    localStorage.setItem(TOKEN_KEY, newToken)
    localStorage.setItem(USER_KEY, JSON.stringify(newUser))
    setToken(newToken)
    setUser(newUser)
    return newUser
  }, [])

  const logout = useCallback(async () => {
    try {
      await client.post('/auth/logout')
    } catch {
      // Ignore logout errors
    }
    clearAuth()
    toast.success('Logged out successfully')
  }, [clearAuth])

  const isAuthenticated = Boolean(user && token)

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated, loading }}>
      {children}
    </AuthContext.Provider>
  )
}
