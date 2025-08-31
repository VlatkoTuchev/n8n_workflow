import React from 'react'
import './Home.css'

export default function Home() {
  return (
    <>
      <canvas id="bg"></canvas>
      <div className="header">
        <div>
          <h1>📚 Course Finder Buddy</h1>
          <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 14 }}>Your AI-powered learning companion for discovering the perfect courses</p>
        </div>
        <div className="actions">
          <button className="logout-btn" onClick={async ()=>{ try { await fetch('/auth/logout', { method: 'POST' }); } catch (_) {} location.href='/login' }}>Log out</button>
        </div>
      </div>
      <div className="main-content">
        <h2 style={{ color: '#4a4a4a', marginBottom: 10 }}>Featured Courses</h2>
        <p style={{ color: '#7a7a7a' }}>Explore our curated selection of courses tailored to your learning journey</p>
        <div className="course-grid">
          {[
            { t: 'Web Development Bootcamp', p: 'Master modern web technologies including HTML5, CSS3, JavaScript, and React.', tags: ['Beginner','12 weeks'] },
            { t: 'Data Science Fundamentals', p: 'Learn Python, statistics, and machine learning basics for data analysis.', tags: ['Intermediate','8 weeks'] },
            { t: 'Digital Marketing Mastery', p: 'Comprehensive guide to SEO, social media, and content marketing strategies.', tags: ['All Levels','6 weeks'] },
            { t: 'AI & Machine Learning', p: 'Deep dive into neural networks, deep learning, and AI applications.', tags: ['Advanced','16 weeks'] },
            { t: 'UX/UI Design Principles', p: 'Create stunning user interfaces and exceptional user experiences.', tags: ['Intermediate','10 weeks'] },
            { t: 'Business Analytics', p: 'Transform data into actionable business insights and strategies.', tags: ['Intermediate','8 weeks'] },
          ].map((c, i) => (
            <div key={i} className="course-card">
              <h3>{c.t}</h3>
              <p>{c.p}</p>
              <div>
                {c.tags.map((tg, j) => (<span key={j} className="course-tag">{tg}</span>))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}


