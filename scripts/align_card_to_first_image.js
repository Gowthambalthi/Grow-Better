const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'src', 'scalping-app.jsx');
let code = fs.readFileSync(targetFile, 'utf8');
const hadCRLF = code.includes('\r\n');
code = code.replace(/\r\n/g, '\n');

// Find the UpcomingEventsSquareBox item map
const oldCardPattern = `: displayList.slice(0, 50).map(item => {
            const c = item.c;
            const ltp = Number(c.ltp || c.price || 0);
            const movePct = Number(c.movePct || 0);
            const isPos = movePct >= 0;
            const sign = isPos ? '+' : '';

            return /*#__PURE__*/React.createElement("div", {
              key: \`\${item.sym}-\${item.evType}-\${item.ts}\`,
              className: "top-news-item",
              onClick: () => onCopy && onCopy(item.sym),
              title: \`Click to copy \${item.sym} · Event: \${item.badge}\`
            },
              /* Top Row */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-item-top",
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }
              },
                /* Left Symbol & Timing / Upcoming directly underneath */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-item-left",
                  style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }
                },
                  /* Row 1: Symbol + Company Tier */
                  /*#__PURE__*/React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: '6px' }
                  },
                    /*#__PURE__*/React.createElement("span", {
                      className: "top-news-sym"
                    }, item.sym),
                    (() => {
                      const tier = getCompanyTier(item.sym);
                      if (!tier) return null;
                      return /*#__PURE__*/React.createElement("span", {
                        style: {
                          fontSize: '10.5px',
                          fontWeight: 600,
                          color: 'var(--text-muted, #64748b)',
                          whiteSpace: 'nowrap',
                          background: 'none',
                          border: 'none',
                          padding: 0
                        },
                        title: \`\${tier.name} Company\`
                      }, tier.name);
                    })()
                  ),
                  /* Row 2: Prominent "Upcoming" or scheduled date directly under symbol */
                  /*#__PURE__*/React.createElement("span", {
                    style: {
                      fontSize: '11px',
                      fontWeight: 500,
                      color: 'var(--text-muted, #64748b)',
                      lineHeight: 1.2
                    }
                  }, item.eventDateStr || 'Upcoming')
                ),

                /* Right Price & Event Badge */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-item-right",
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: '3px',
                    flexShrink: 0,
                    textAlign: 'right'
                  }
                },
                  ltp > 0 && /*#__PURE__*/React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: '6px' }
                  },
                    /*#__PURE__*/React.createElement("span", {
                      className: "top-news-price",
                      style: { fontWeight: 800, fontSize: '12px' }
                    }, \`₹\${ltp.toFixed(2)}\`),
                    /*#__PURE__*/React.createElement("span", {
                      style: {
                        fontSize: '11px',
                        fontWeight: 600,
                        color: movePct > 0 ? '#16a34a' : movePct < 0 ? '#dc2626' : '#64748b',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                        background: 'none',
                        border: 'none',
                        padding: 0
                      }
                    }, \`\${sign}\${movePct.toFixed(1)}%\`)
                  ),

                  /* Event Badge Pill (Clean text, NO emoji) */
                  /*#__PURE__*/React.createElement("span", {
                    style: {
                      fontSize: '10.5px',
                      fontWeight: 700,
                      color: item.badgeColor,
                      background: item.badgeBg,
                      border: \`1px solid \${item.badgeBorder}\`,
                      padding: '2px 7px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap',
                      lineHeight: 1.2
                    }
                  }, item.badge)
                )
              ),

              /* Bottom Headline / Purpose */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-headline",
                style: {
                  marginTop: '4px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                },
                title: c.title || c.description
              }, c.title || c.description || \`\${item.sym} Corporate Announcement\`)
            );
          })`;

const newCardPattern = `: displayList.slice(0, 50).map(item => {
            const c = item.c;
            const ltp = Number(c.ltp || c.price || 0);
            const movePct = Number(c.movePct || 0);
            const isPos = movePct >= 0;
            const sign = isPos ? '+' : '';

            return /*#__PURE__*/React.createElement("div", {
              key: \`\${item.sym}-\${item.evType}-\${item.ts}\`,
              className: "top-news-item",
              onClick: () => onCopy && onCopy(item.sym),
              title: \`Click to copy \${item.sym} · Event: \${item.badge}\`
            },
              /* Top Row (Identical layout to First Image) */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-item-top",
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }
              },
                /* Left side: Symbol + Tier on row 1, Price + Day % on row 2 (Exactly like First Image) */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-item-left",
                  style: { display: 'flex', flexDirection: 'column', gap: '2px' }
                },
                  /* Row 1: Symbol + Company Tier */
                  /*#__PURE__*/React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: '6px' }
                  },
                    /*#__PURE__*/React.createElement("span", {
                      className: "top-news-sym"
                    }, item.sym),
                    (() => {
                      const tier = getCompanyTier(item.sym);
                      if (!tier) return null;
                      return /*#__PURE__*/React.createElement("span", {
                        style: {
                          fontSize: '10.5px',
                          fontWeight: 600,
                          color: 'var(--text-muted, #64748b)',
                          whiteSpace: 'nowrap',
                          background: 'none',
                          border: 'none',
                          padding: 0
                        },
                        title: \`\${tier.name} Company\`
                      }, tier.name);
                    })()
                  ),
                  /* Row 2: LTP Price and Day Move % (In Next Line, Plain text, NO background box) */
                  ltp > 0 && /*#__PURE__*/React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: '6px' }
                  },
                    /*#__PURE__*/React.createElement("span", {
                      className: "top-news-price",
                      style: { fontWeight: 800, fontSize: '12px' }
                    }, \`₹\${ltp.toFixed(2)}\`),
                    /* Day Percentage: pure text, NO background box */
                    /*#__PURE__*/React.createElement("span", {
                      style: {
                        fontSize: '11px',
                        fontWeight: 600,
                        color: movePct > 0 ? '#16a34a' : movePct < 0 ? '#dc2626' : '#64748b',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                        background: 'none',
                        border: 'none',
                        padding: 0
                      },
                      title: \`Day session move: \${sign}\${movePct.toFixed(2)}%\`
                    }, \`\${sign}\${movePct.toFixed(1)}%\`)
                  )
                ),

                /* Right side: Day % change at top, Event Badge below (Clean text, NO background box, exactly like First Image) */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-item-right",
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: '2px',
                    flexShrink: 0,
                    textAlign: 'right'
                  }
                },
                  /* Row 1: Stock Day % Change (Clean text, NO box, like +1.9%) */
                  /*#__PURE__*/React.createElement("span", {
                    style: {
                      fontSize: '11px',
                      fontWeight: 700,
                      color: movePct > 0 ? '#16a34a' : movePct < 0 ? '#dc2626' : '#16a34a',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      margin: 0,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                      lineHeight: 1.2
                    },
                    title: \`Day session move: \${sign}\${movePct.toFixed(2)}%\`
                  }, \`\${sign}\${movePct.toFixed(1)}%\`),

                  /* Row 2: Event Badge (Clean text, NO box, like Buy 92%) */
                  /*#__PURE__*/React.createElement("span", {
                    className: "top-news-trade-pill",
                    style: {
                      fontSize: '11px',
                      fontWeight: 700,
                      color: item.badgeColor || '#059669',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      margin: 0,
                      letterSpacing: '0.01em',
                      whiteSpace: 'nowrap',
                      lineHeight: 1.2
                    },
                    title: \`Corporate Event: \${item.badge}\`
                  }, item.badge)
                )
              ),

              /* Row 2: Headline matter parallel with timing at the end of the right side (Exactly like First Image) */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-matter-row",
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  flexWrap: 'nowrap',
                  gap: '8px',
                  width: '100%',
                  minWidth: 0,
                  marginTop: '4px'
                }
              },
                /* Matter (Headline text) */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-headline",
                  style: {
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  },
                  title: c.title || c.description
                }, c.title || c.description || \`\${item.sym} Corporate Announcement\`),

                /* Timing parallel to the matter at the end of right side */
                /*#__PURE__*/React.createElement("span", {
                  className: "top-news-time",
                  style: {
                    fontSize: '10px',
                    fontWeight: 500,
                    color: 'var(--text-muted, #64748b)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    textAlign: 'right'
                  },
                  title: item.eventDateStr ? \`Scheduled Date: \${item.eventDateStr}\` : 'Upcoming Event'
                }, item.eventDateStr || 'Upcoming')
              )
            );
          })`;

if (code.includes(oldCardPattern)) {
  code = code.replace(oldCardPattern, newCardPattern);
  console.log('PASS: Replaced card layout with First Image layout');
} else {
  console.log('FAIL: oldCardPattern not matched');
}

if (hadCRLF) {
  code = code.replace(/\n/g, '\r\n');
}

fs.writeFileSync(targetFile, code, 'utf8');
console.log('DONE!');
