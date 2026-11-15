const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'src', 'scalping-app.jsx');
let code = fs.readFileSync(targetFile, 'utf8');
const hadCRLF = code.includes('\r\n');
code = code.replace(/\r\n/g, '\n');

// 1. Live News Card: ensure top-news-matter-row has flexWrap: 'nowrap' and top-news-headline has nowrap + ellipsis
const oldLiveNewsPattern = `    /* Row 2: Headline matter parallel with timing at the end of the right side */
    /*#__PURE__*/React.createElement("div", {
      className: "top-news-matter-row",
      style: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        minWidth: 0
      }
    },
      /* Matter (Headline text) */
      /*#__PURE__*/React.createElement("div", {
        className: "top-news-headline",
        style: {
          flex: 1,
          minWidth: 0
        },`;

const newLiveNewsPattern = `    /* Row 2: Headline matter parallel with timing at the end of the right side */
    /*#__PURE__*/React.createElement("div", {
      className: "top-news-matter-row",
      style: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        flexWrap: 'nowrap',
        gap: '8px',
        width: '100%',
        minWidth: 0
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
        },`;

if (code.includes(oldLiveNewsPattern)) {
  code = code.replace(oldLiveNewsPattern, newLiveNewsPattern);
  console.log('PASS: Updated Live News matter row style (nowrap + ellipsis)');
} else {
  console.log('SKIP: oldLiveNewsPattern not matched');
}

// 2. State in UpcomingEventsSquareBox
const oldUpcomingState = `  const [selectedTypes, setSelectedTypes] = React.useState(['ALL']);
  const [selectedDate, setSelectedDate] = React.useState('ALL');
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = React.useState(false);
  const typeDropdownRef = React.useRef(null);`;

const newUpcomingState = `  const [selectedTypes, setSelectedTypes] = React.useState(['ALL']);
  const [calendarMode, setCalendarMode] = React.useState('ALL'); // 'ALL' | 'UPCOMING' | 'DATE'
  const [calendarDate, setCalendarDate] = React.useState('');
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = React.useState(false);
  const typeDropdownRef = React.useRef(null);`;

if (code.includes(oldUpcomingState)) {
  code = code.replace(oldUpcomingState, newUpcomingState);
  console.log('PASS: Updated UpcomingEventsSquareBox state');
} else {
  console.log('SKIP: oldUpcomingState not matched');
}

// 3. Store isoDate in classified.push
const oldClassifiedBlock = `        if (!seen.has(key)) {
          seen.add(key);
          const tsVal = Number(c.ts || c.timeMs || 0);
          classified.push({
            c,
            sym,
            evType,
            badge,
            badgeColor,
            badgeBg,
            badgeBorder,
            priority,
            eventDateStr,
            ts: tsVal
          });
        }`;

const newClassifiedBlock = `        if (!seen.has(key)) {
          seen.add(key);
          const tsVal = Number(c.ts || c.timeMs || 0);
          const isoDate = tsVal > 0 ? new Date(tsVal + 330 * 60000).toISOString().slice(0, 10) : '';
          classified.push({
            c,
            sym,
            evType,
            badge,
            badgeColor,
            badgeBg,
            badgeBorder,
            priority,
            eventDateStr,
            isoDate,
            ts: tsVal
          });
        }`;

if (code.includes(oldClassifiedBlock)) {
  code = code.replace(oldClassifiedBlock, newClassifiedBlock);
  console.log('PASS: Added isoDate to classified items');
} else {
  console.log('SKIP: oldClassifiedBlock not matched');
}

// 4. Update typeButtonLabel & displayList
const oldDisplayBlock = `  const typeButtonLabel = React.useMemo(() => {
    if (selectedTypes.includes('ALL') || selectedTypes.length === 0) {
      return 'All Types';
    }
    if (selectedTypes.length === 1) {
      const found = EVENT_TYPES.find(t => t.key === selectedTypes[0]);
      return found ? found.label : selectedTypes[0];
    }
    return \`\${selectedTypes.length} Types\`;
  }, [selectedTypes, EVENT_TYPES]);

  const displayList = React.useMemo(() => {
    return eventsList.filter(item => {
      if (!selectedTypes.includes('ALL') && selectedTypes.length > 0) {
        if (!selectedTypes.includes(item.evType)) return false;
      }
      if (selectedDate && selectedDate !== 'ALL') {
        if (selectedDate === 'UPCOMING') {
          if ((item.eventDateStr || 'Upcoming') !== 'Upcoming') return false;
        } else {
          if (item.eventDateStr !== selectedDate) return false;
        }
      }
      return true;
    });
  }, [eventsList, selectedTypes, selectedDate]);`;

const newDisplayBlock = `  const typeButtonLabel = React.useMemo(() => {
    if (selectedTypes.includes('ALL') || selectedTypes.length === 0) {
      return 'Types ▾';
    }
    if (selectedTypes.length === 1) {
      const found = EVENT_TYPES.find(t => t.key === selectedTypes[0]);
      return \`\${found ? found.label : selectedTypes[0]} ▾\`;
    }
    return \`\${selectedTypes.length} Types ▾\`;
  }, [selectedTypes, EVENT_TYPES]);

  const displayList = React.useMemo(() => {
    return eventsList.filter(item => {
      // 1. Filter by event type: All vs select as your wish
      if (!selectedTypes.includes('ALL') && selectedTypes.length > 0) {
        if (!selectedTypes.includes(item.evType)) return false;
      }
      // 2. Filter by calendar: All vs Upcoming vs Picked Date
      if (calendarMode === 'UPCOMING') {
        if ((item.eventDateStr || 'Upcoming') !== 'Upcoming') return false;
      } else if (calendarMode === 'DATE' && calendarDate) {
        if (item.isoDate && item.isoDate === calendarDate) return true;
        const parts = calendarDate.split('-');
        if (parts.length === 3) {
          const day = parseInt(parts[2], 10);
          const mIdx = parseInt(parts[1], 10) - 1;
          const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
          const mShort = monthNames[mIdx] || '';
          const text = \`\${item.eventDateStr || ''} \${item.c?.title || ''} \${item.c?.description || ''} \${item.c?.filingTime || ''}\`.toLowerCase();
          const reg = new RegExp(\`\\\\b(?:\${day}(?:st|nd|rd|th)?\\\\s+\${mShort}|\${mShort}\\\\s+\${day}(?:st|nd|rd|th)?)\\\\b\`, 'i');
          if (reg.test(text)) return true;
        }
        return false;
      }
      return true;
    });
  }, [eventsList, selectedTypes, calendarMode, calendarDate]);`;

if (code.includes(oldDisplayBlock)) {
  code = code.replace(oldDisplayBlock, newDisplayBlock);
  console.log('PASS: Updated typeButtonLabel & displayList');
} else {
  console.log('SKIP: oldDisplayBlock not matched');
}

// 5. Update Header Controls (Type filter with [All] + Dropdown, Calendar with [All] + [Upcoming] + Date Picker)
const oldHeaderRightBlock = `      /* Right Controls: Type filter on left, Calendar on right (NO duplicate All buttons) */
      /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          justifyContent: 'flex-end'
        }
      },
        /* 1. Type Filter (Multi-select or single select) */
        /*#__PURE__*/React.createElement("div", {
          ref: typeDropdownRef,
          style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '4px' }
        },
          /* "Type:" label */
          /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-muted, #64748b)',
              whiteSpace: 'nowrap'
            }
          }, "Type:"),

          /* Multi-Select Dropdown Button (NO duplicate All button outside!) */
          /*#__PURE__*/React.createElement("button", {
            type: "button",
            onClick: () => setIsTypeDropdownOpen(v => !v),
            style: {
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: (!selectedTypes.includes('ALL') && selectedTypes.length > 0) ? '1px solid #3b82f6' : '1px solid var(--border-color, #cbd5e1)',
              background: (!selectedTypes.includes('ALL') && selectedTypes.length > 0) ? 'rgba(59, 130, 246, 0.10)' : 'var(--card-bg, #ffffff)',
              color: (!selectedTypes.includes('ALL') && selectedTypes.length > 0) ? '#2563eb' : 'var(--text, #0f172a)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: "Select multiple or single event types"
          },
            typeButtonLabel,
            /*#__PURE__*/React.createElement("span", { style: { fontSize: '9px', opacity: 0.7 } }, isTypeDropdownOpen ? '▲' : '▼')
          ),

          /* Floating Multi-Select Dropdown Menu */
          isTypeDropdownOpen && /*#__PURE__*/React.createElement("div", {
            style: {
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              zIndex: 9999,
              background: 'var(--card-bg, #ffffff)',
              border: '1px solid var(--border-color, #cbd5e1)',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              padding: '6px 0',
              minWidth: '170px',
              display: 'flex',
              flexDirection: 'column'
            }
          },
            /* Option: All Types */
            /*#__PURE__*/React.createElement("label", {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                color: 'var(--text, #0f172a)',
                background: (selectedTypes.includes('ALL') || selectedTypes.length === 0) ? 'rgba(34, 197, 94, 0.08)' : 'transparent'
              },
              onClick: (e) => {
                e.stopPropagation();
                setSelectedTypes(['ALL']);
              }
            },
              /*#__PURE__*/React.createElement("input", {
                type: "checkbox",
                checked: selectedTypes.includes('ALL') || selectedTypes.length === 0,
                onChange: () => setSelectedTypes(['ALL']),
                style: { cursor: 'pointer', accentColor: '#16a34a' }
              }),
              "All Types"
            ),
            /* Divider */
            /*#__PURE__*/React.createElement("div", {
              style: { height: '1px', background: 'var(--border-color, #e2e8f0)', margin: '4px 0' }
            }),
            /* Individual Event Types */
            EVENT_TYPES.map(t => {
              const isChecked = !selectedTypes.includes('ALL') && selectedTypes.includes(t.key);
              const count = typeCounts[t.key] || 0;
              return /*#__PURE__*/React.createElement("label", {
                key: t.key,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 12px',
                  fontSize: '11px',
                  fontWeight: isChecked ? 700 : 500,
                  cursor: 'pointer',
                  color: isChecked ? '#2563eb' : 'var(--text, #0f172a)',
                  background: isChecked ? 'rgba(59, 130, 246, 0.06)' : 'transparent'
                },
                onClick: (e) => {
                  e.stopPropagation();
                  toggleType(t.key);
                }
              },
                /*#__PURE__*/React.createElement("div", {
                  style: { display: 'flex', alignItems: 'center', gap: '8px' }
                },
                  /*#__PURE__*/React.createElement("input", {
                    type: "checkbox",
                    checked: isChecked,
                    onChange: () => toggleType(t.key),
                    style: { cursor: 'pointer', accentColor: '#2563eb' }
                  }),
                  t.label
                ),
                count > 0 && /*#__PURE__*/React.createElement("span", {
                  style: {
                    fontSize: '9.5px',
                    fontWeight: 700,
                    color: 'var(--text-muted, #94a3b8)',
                    fontVariantNumeric: 'tabular-nums'
                  }
                }, count)
              );
            })
          )
        ),

        /* 2. Calendar Selector (at right corner at top, self-contained, NO duplicate All button!) */
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', alignItems: 'center', gap: '4px' }
        },
          /* "Calendar:" label */
          /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-muted, #64748b)',
              whiteSpace: 'nowrap'
            }
          }, "Calendar:"),

          /* Clean Selector with All Dates default option */
          /*#__PURE__*/React.createElement("select", {
            value: selectedDate,
            onChange: (e) => setSelectedDate(e.target.value),
            style: {
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: selectedDate !== 'ALL' ? '1px solid #3b82f6' : '1px solid var(--border-color, #cbd5e1)',
              background: selectedDate !== 'ALL' ? 'rgba(59, 130, 246, 0.08)' : 'var(--card-bg, #ffffff)',
              color: selectedDate !== 'ALL' ? '#2563eb' : 'var(--text, #0f172a)',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: "Filter by corporate event scheduled date"
          },
            /*#__PURE__*/React.createElement("option", { value: "ALL" }, \`All Dates (\${eventsList.length})\`),
            upcomingCount > 0 && /*#__PURE__*/React.createElement("option", { value: "UPCOMING" }, \`Upcoming (\${upcomingCount})\`),
            availableDates.map(d => /*#__PURE__*/React.createElement("option", {
              key: d.key,
              value: d.key
            }, \`\${d.label} (\${d.count})\`))
          )
        )
      )`;

const newHeaderRightBlock = `      /* Right Controls: Type filter on left, Calendar on right (Both have All + select as your wish) */
      /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          justifyContent: 'flex-end'
        }
      },
        /* 1. Type Filter: [All] button + [Types ▾] multi-select dropdown */
        /*#__PURE__*/React.createElement("div", {
          ref: typeDropdownRef,
          style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '4px' }
        },
          /* "Type:" label */
          /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-muted, #64748b)',
              whiteSpace: 'nowrap'
            }
          }, "Type:"),

          /* "All" button for Type */
          /*#__PURE__*/React.createElement("button", {
            type: "button",
            onClick: () => setSelectedTypes(['ALL']),
            style: {
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: (selectedTypes.includes('ALL') || selectedTypes.length === 0) ? '1px solid #86efac' : '1px solid var(--border-color, #cbd5e1)',
              background: (selectedTypes.includes('ALL') || selectedTypes.length === 0) ? 'rgba(34, 197, 94, 0.12)' : 'var(--card-bg, #ffffff)',
              color: (selectedTypes.includes('ALL') || selectedTypes.length === 0) ? '#16a34a' : 'var(--text-muted, #64748b)',
              display: 'inline-flex',
              alignItems: 'center',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: "Show all event types"
          }, "All"),

          /* Multi-Select Dropdown Button for Type ("select as your wish") */
          /*#__PURE__*/React.createElement("button", {
            type: "button",
            onClick: () => setIsTypeDropdownOpen(v => !v),
            style: {
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: (!selectedTypes.includes('ALL') && selectedTypes.length > 0) ? '1px solid #3b82f6' : '1px solid var(--border-color, #cbd5e1)',
              background: (!selectedTypes.includes('ALL') && selectedTypes.length > 0) ? 'rgba(59, 130, 246, 0.10)' : 'var(--card-bg, #ffffff)',
              color: (!selectedTypes.includes('ALL') && selectedTypes.length > 0) ? '#2563eb' : 'var(--text, #0f172a)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: "Select individual event types as your wish"
          },
            typeButtonLabel,
            /*#__PURE__*/React.createElement("span", { style: { fontSize: '9px', opacity: 0.7 } }, isTypeDropdownOpen ? '▲' : '▼')
          ),

          /* Floating Multi-Select Dropdown Menu */
          isTypeDropdownOpen && /*#__PURE__*/React.createElement("div", {
            style: {
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              zIndex: 9999,
              background: 'var(--card-bg, #ffffff)',
              border: '1px solid var(--border-color, #cbd5e1)',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              padding: '6px 0',
              minWidth: '170px',
              display: 'flex',
              flexDirection: 'column'
            }
          },
            /* Option: All Types */
            /*#__PURE__*/React.createElement("label", {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                color: 'var(--text, #0f172a)',
                background: (selectedTypes.includes('ALL') || selectedTypes.length === 0) ? 'rgba(34, 197, 94, 0.08)' : 'transparent'
              },
              onClick: (e) => {
                e.stopPropagation();
                setSelectedTypes(['ALL']);
              }
            },
              /*#__PURE__*/React.createElement("input", {
                type: "checkbox",
                checked: selectedTypes.includes('ALL') || selectedTypes.length === 0,
                onChange: () => setSelectedTypes(['ALL']),
                style: { cursor: 'pointer', accentColor: '#16a34a' }
              }),
              "All Types"
            ),
            /* Divider */
            /*#__PURE__*/React.createElement("div", {
              style: { height: '1px', background: 'var(--border-color, #e2e8f0)', margin: '4px 0' }
            }),
            /* Individual Event Types */
            EVENT_TYPES.map(t => {
              const isChecked = !selectedTypes.includes('ALL') && selectedTypes.includes(t.key);
              const count = typeCounts[t.key] || 0;
              return /*#__PURE__*/React.createElement("label", {
                key: t.key,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 12px',
                  fontSize: '11px',
                  fontWeight: isChecked ? 700 : 500,
                  cursor: 'pointer',
                  color: isChecked ? '#2563eb' : 'var(--text, #0f172a)',
                  background: isChecked ? 'rgba(59, 130, 246, 0.06)' : 'transparent'
                },
                onClick: (e) => {
                  e.stopPropagation();
                  toggleType(t.key);
                }
              },
                /*#__PURE__*/React.createElement("div", {
                  style: { display: 'flex', alignItems: 'center', gap: '8px' }
                },
                  /*#__PURE__*/React.createElement("input", {
                    type: "checkbox",
                    checked: isChecked,
                    onChange: () => toggleType(t.key),
                    style: { cursor: 'pointer', accentColor: '#2563eb' }
                  }),
                  t.label
                ),
                count > 0 && /*#__PURE__*/React.createElement("span", {
                  style: {
                    fontSize: '9.5px',
                    fontWeight: 700,
                    color: 'var(--text-muted, #94a3b8)',
                    fontVariantNumeric: 'tabular-nums'
                  }
                }, count)
              );
            })
          )
        ),

        /* 2. Calendar Selector: [All] button + [Upcoming] button + Calendar Date Picker */
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', alignItems: 'center', gap: '4px' }
        },
          /* "Calendar:" label */
          /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--text-muted, #64748b)',
              whiteSpace: 'nowrap'
            }
          }, "Calendar:"),

          /* "All" button for Calendar */
          /*#__PURE__*/React.createElement("button", {
            type: "button",
            onClick: () => {
              setCalendarMode('ALL');
              setCalendarDate('');
            },
            style: {
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: calendarMode === 'ALL' ? '1px solid #86efac' : '1px solid var(--border-color, #cbd5e1)',
              background: calendarMode === 'ALL' ? 'rgba(34, 197, 94, 0.12)' : 'var(--card-bg, #ffffff)',
              color: calendarMode === 'ALL' ? '#16a34a' : 'var(--text-muted, #64748b)',
              display: 'inline-flex',
              alignItems: 'center',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: "Show events from all dates"
          }, "All"),

          /* "Upcoming" button */
          /*#__PURE__*/React.createElement("button", {
            type: "button",
            onClick: () => {
              setCalendarMode('UPCOMING');
              setCalendarDate('');
            },
            style: {
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 8px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: calendarMode === 'UPCOMING' ? '1px solid #3b82f6' : '1px solid var(--border-color, #cbd5e1)',
              background: calendarMode === 'UPCOMING' ? 'rgba(59, 130, 246, 0.12)' : 'var(--card-bg, #ffffff)',
              color: calendarMode === 'UPCOMING' ? '#2563eb' : 'var(--text-muted, #64748b)',
              display: 'inline-flex',
              alignItems: 'center',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: \`Show upcoming events (\${upcomingCount})\`
          }, \`Upcoming\${upcomingCount > 0 ? \` (\${upcomingCount})\` : ''}\`),

          /* Calendar Date Picker Input: "Select as your wish" */
          /*#__PURE__*/React.createElement("input", {
            type: "date",
            value: calendarDate,
            onChange: (e) => {
              const val = e.target.value;
              setCalendarDate(val);
              if (val) {
                setCalendarMode('DATE');
              } else {
                setCalendarMode('ALL');
              }
            },
            style: {
              fontSize: '11px',
              fontWeight: (calendarMode === 'DATE' && calendarDate) ? 700 : 500,
              padding: '1px 6px',
              height: '24px',
              borderRadius: '5px',
              cursor: 'pointer',
              boxSizing: 'border-box',
              border: (calendarMode === 'DATE' && calendarDate) ? '1px solid #3b82f6' : '1px solid var(--border-color, #cbd5e1)',
              background: (calendarMode === 'DATE' && calendarDate) ? 'rgba(59, 130, 246, 0.10)' : 'var(--card-bg, #ffffff)',
              color: (calendarMode === 'DATE' && calendarDate) ? '#2563eb' : 'var(--text, #0f172a)',
              outline: 'none',
              transition: 'all 0.15s ease'
            },
            title: "Select any date from calendar (select as your wish)"
          })
        )
      )`;

if (code.includes(oldHeaderRightBlock)) {
  code = code.replace(oldHeaderRightBlock, newHeaderRightBlock);
  console.log('PASS: Updated Header Right Controls with All + Select-as-your-wish for both Type & Calendar');
} else {
  console.log('SKIP: oldHeaderRightBlock not matched');
}

// 6. Update empty state in UpcomingEventsSquareBox
const oldEmptyState = `          displayList.length === 0
          ? /*#__PURE__*/React.createElement("div", {
              style: {
                padding: '24px',
                textAlign: 'center',
                color: 'var(--text-muted, #64748b)',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px'
              }
            },
              /*#__PURE__*/React.createElement("span", null, "No scheduled corporate events matching selected filters."),
              /*#__PURE__*/React.createElement("button", {
                type: "button",
                onClick: () => {
                  setSelectedTypes(['ALL']);
                  setSelectedDate('ALL');
                },
                style: {
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#2563eb',
                  background: 'none',
                  border: '1px solid #93c5fd',
                  borderRadius: '4px',
                  padding: '3px 8px',
                  cursor: 'pointer'
                }
              }, "Show All Events")
            )`;

const newEmptyState = `          displayList.length === 0
          ? /*#__PURE__*/React.createElement("div", {
              style: {
                padding: '24px 16px',
                textAlign: 'center',
                color: 'var(--text-muted, #64748b)',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px'
              }
            },
              /*#__PURE__*/React.createElement("span", {
                style: {
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--text-muted, #64748b)'
                }
              }, (calendarMode === 'DATE' && calendarDate) ? \`No scheduled corporate events on \${calendarDate}\` : "No scheduled corporate events matching selected filters."),
              /*#__PURE__*/React.createElement("button", {
                type: "button",
                onClick: () => {
                  setSelectedTypes(['ALL']);
                  setCalendarMode('ALL');
                  setCalendarDate('');
                },
                style: {
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#16a34a',
                  background: 'rgba(34, 197, 94, 0.10)',
                  border: '1px solid #86efac',
                  borderRadius: '5px',
                  padding: '4px 12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }
              }, "Show All Events")
            )`;

if (code.includes(oldEmptyState)) {
  code = code.replace(oldEmptyState, newEmptyState);
  console.log('PASS: Updated empty state');
} else {
  console.log('SKIP: oldEmptyState not matched');
}

// 7. Ensure headline in UpcomingEventsSquareBox items has nowrap and ellipsis
const oldUpcomingHeadline = `              /* Bottom Headline / Purpose */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-headline",
                style: { marginTop: '4px' },
                title: c.title || c.description
              }, c.title || c.description || \`\${item.sym} Corporate Announcement\`)`;

const newUpcomingHeadline = `              /* Bottom Headline / Purpose */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-headline",
                style: {
                  marginTop: '4px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                },
                title: c.title || c.description
              }, c.title || c.description || \`\${item.sym} Corporate Announcement\`)`;

if (code.includes(oldUpcomingHeadline)) {
  code = code.replace(oldUpcomingHeadline, newUpcomingHeadline);
  console.log('PASS: Updated UpcomingEventsSquareBox item headline style (nowrap + ellipsis)');
} else {
  console.log('SKIP: oldUpcomingHeadline not matched');
}

if (hadCRLF) {
  code = code.replace(/\n/g, '\r\n');
}

fs.writeFileSync(targetFile, code, 'utf8');
console.log('ALL DONE! Successfully updated src/scalping-app.jsx');
