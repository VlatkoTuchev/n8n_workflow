import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './ui/App'
import Home from './ui/pages/Home'
import Login from './ui/pages/Login'
import Signup from './ui/pages/Signup'

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/app', element: <App /> },
  { path: '/login', element: <Login /> },
  { path: '/signup', element: <Signup /> },
])

const root = createRoot(document.getElementById('root')!)
root.render(<RouterProvider router={router} />)


